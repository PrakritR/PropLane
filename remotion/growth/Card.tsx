import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

import { FONT_FAMILY, loadBrandFont } from "./fonts";
import type { CardProps } from "./types";

loadBrandFont();

/** 1080x1350 still for carousel/image posts: title + hook on the brand background. */
export const Card: React.FC<CardProps> = ({ title, hook, body, index, total, brand }) => {
  const headline = body?.trim() || hook?.trim() || title;
  const showTitle = Boolean(body?.trim() || hook?.trim());
  return (
    <AbsoluteFill
      style={{
        fontFamily: `${FONT_FAMILY}, system-ui, sans-serif`,
        background: `radial-gradient(900px 700px at 85% 0%, #5a8cff 0%, transparent 60%), linear-gradient(160deg, #1e4fd6 0%, ${brand.blue} 55%, #08090b 140%)`,
        color: "#fff",
        padding: 90,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <Img src={staticFile(brand.mark)} style={{ width: 84, height: 84 }} />
        <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -0.5 }}>PropLane</span>
      </div>
      <div>
        {showTitle ? <div style={{ fontSize: 36, fontWeight: 600, opacity: 0.8, marginBottom: 28, textTransform: "uppercase", letterSpacing: 3 }}>{title}</div> : null}
        <div style={{ fontSize: headline.length > 70 ? 88 : 112, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2.5, textWrap: "balance" }}>{headline}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 38, fontWeight: 600, opacity: 0.9 }}>
        <span>prop-lane.space</span>
        {total > 1 ? <span>{index + 1} / {total}</span> : null}
      </div>
    </AbsoluteFill>
  );
};
