"use client";

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Modal } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { getStripe } from "@/lib/stripe-browser";

export function StripeCheckoutModal({
  clientSecret,
  onClose,
}: {
  clientSecret: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      title="Checkout"
      onClose={onClose}
      assistantStrip={false}
      scrollableContent
      panelClassName={MODAL_LARGE_PANEL_CLASS}
    >
      <div className="min-h-[min(50vh,28rem)]">
        <EmbeddedCheckoutProvider stripe={getStripe()} options={{ clientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </Modal>
  );
}
