"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";

type Card = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};
const ENDPOINT = "/api/manager/payment-methods";
export function ManagerPaymentMethodsPanel() {
  const { isNative } = useIsNativeApp();
  const [cards, setCards] = useState<Card[] | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [defaultPending, setDefaultPending] = useState(false);
  const defaultBusy = useRef(false);
  const [open, setOpen] = useState(false),
    [secret, setSecret] = useState<string | null>(null),
    [setupError, setSetupError] = useState<string | null>(null),
    [starting, setStarting] = useState(false);
  const operation = useRef<string | null>(null),
    active = useRef(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, {
        credentials: "include",
        cache: "no-store",
      });
      const body = await res.json();
      if (!res.ok || !Array.isArray(body.cards))
        throw new Error(body.error || "Saved cards could not be loaded.");
      if (active.current) {
        setCards(body.cards);
        setError(null);
      }
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error ? e.message : "Saved cards could not be loaded.",
        );
    }
  }, []);
  useEffect(() => {
    active.current = true;
    // load writes state only after the asynchronous network response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);
  async function addCard() {
    if (starting || isNative !== false) return;
    setStarting(true);
    setOpen(true);
    setSetupError(null);
    operation.current ??= crypto.randomUUID();
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: operation.current }),
      });
      const body = await res.json();
      if (!res.ok || !body.clientSecret)
        throw new Error(body.error || "Card setup could not be opened.");
      setSecret(body.clientSecret);
    } catch (e) {
      setSetupError(
        e instanceof Error ? e.message : "Card setup could not be opened.",
      );
    } finally {
      setStarting(false);
    }
  }
  async function makeDefault(id: string) {
    if (defaultBusy.current) return;
    defaultBusy.current = true;
    setDefaultPending(true);
    setNotice(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethodId: id }),
      });
      const body = await res.json();
      if (!res.ok || !Array.isArray(body.cards))
        throw new Error(body.error || "The default card could not be changed.");
      setCards(body.cards);
      setNotice("Default card updated.");
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message
          : "The default card could not be changed. Please try again.",
      );
    } finally {
      defaultBusy.current = false;
      setDefaultPending(false);
    }
  }
  const close = () => {
    setOpen(false);
    setSecret(null);
    operation.current = null;
    setSetupError(null);
    void load();
  };
  return (
    <PortalSettingsSection
      title="Payment methods"
      description="Cards securely saved with Stripe for PropLane billing."
    >
      <PortalSettingsGroup>
        <div className="flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="text-sm text-muted">
            Choose the default card for future subscription payments.
          </p>
          {isNative === false ? (
            <Button
              variant="outline"
              disabled={starting || defaultPending || Boolean(error)}
              onClick={() => addCard()}
              data-attr="billing-add-card"
            >
              Add card
            </Button>
          ) : null}
        </div>
        {error ? (
          <div className="space-y-3 p-5" role="alert">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="outline" onClick={() => load()}>
              Try again
            </Button>
          </div>
        ) : cards === null ? (
          <p className="p-5 text-sm text-muted" role="status">
            Loading saved cards…
          </p>
        ) : cards.length === 0 ? (
          <p className="p-5 text-sm text-muted">
            No cards saved yet. Add a card to use at checkout.
          </p>
        ) : (
          cards.map((card) => (
            <div
              key={card.id}
              className="flex flex-wrap items-center justify-between gap-4 border-t border-border p-5"
            >
              <div>
                <p className="font-semibold">
                  <span className="capitalize">{card.brand}</span> ····{" "}
                  {card.last4}
                </p>
                <p className="mt-1 text-sm text-muted">
                  Expires {String(card.expMonth).padStart(2, "0")}/
                  {card.expYear}
                </p>
              </div>
              {card.isDefault ? (
                <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  Default
                </span>
              ) : isNative === false ? (
                <Button
                  variant="outline"
                  disabled={defaultPending}
                  onClick={() => makeDefault(card.id)}
                  data-attr="billing-card-set-default"
                >
                  Set as default
                </Button>
              ) : null}
            </div>
          ))
        )}
      </PortalSettingsGroup>
      <p className="text-xs text-muted">
        Saving a card does not buy communication credit or enable automatic
        recharge. Credit purchases are confirmed separately at checkout.
      </p>
      {isNative ? (
        <p className="text-xs text-muted">
          Saved cards apply to web billing. App Store subscription payments are
          managed by Apple.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <Modal
        open={open && isNative === false}
        onClose={close}
        title="Add a card"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Secure card setup with Stripe. No payment is collected.
          </p>
          {setupError ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-danger">{setupError}</p>
              <Button variant="outline" onClick={() => addCard()}>
                Retry card setup
              </Button>
            </div>
          ) : secret ? (
            <EmbeddedCheckoutMount
              clientSecret={secret}
              onError={setSetupError}
            />
          ) : (
            <p role="status">Opening secure card setup…</p>
          )}
        </div>
      </Modal>
    </PortalSettingsSection>
  );
}
