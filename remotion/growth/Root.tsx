import React from "react";
import { Composition } from "remotion";

import { Card } from "./Card";
import { Reel } from "./Reel";
import { DEFAULT_END_CARD_MS, FPS, reelDurationMs, type CardProps, type ReelProps } from "./types";

const brand = { mark: "brand/proplane-mark.svg", blue: "#2863f0" };

const reelDefaults: ReelProps = {
  post: { id: "preview", title: "PropLane", hook: "Rent collected. Repairs handled." },
  scenes: [
    { index: 0, kind: "template", startMs: 0, endMs: 3000, text: "Rent collected. Repairs handled.", direction: "" },
    { index: 1, kind: "template", startMs: 3000, endMs: 6000, text: "One place for the whole house.", direction: "" },
  ],
  brand,
  endCardMs: DEFAULT_END_CARD_MS,
};

const cardDefaults: CardProps = { title: "PropLane", hook: "Rent collected. Repairs handled.", index: 0, total: 1, brand };

export const Root: React.FC = () => (
  <>
    <Composition
      id="Reel"
      component={Reel}
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={Math.ceil((reelDurationMs(reelDefaults) / 1000) * FPS)}
      defaultProps={reelDefaults}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, Math.ceil((reelDurationMs(props as unknown as ReelProps) / 1000) * FPS)) })}
    />
    <Composition
      id="Card"
      component={Card}
      width={1080}
      height={1350}
      fps={FPS}
      durationInFrames={1}
      defaultProps={cardDefaults}
    />
  </>
);
