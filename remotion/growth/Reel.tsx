import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { activeWordIndex, chunkAt, groupCaptionWords, type CaptionWord } from "../../src/lib/growth/video/captions.server";
import { FONT_FAMILY, loadBrandFont } from "./fonts";
import { scenesEndMs, type ReelProps, type ReelScene } from "./types";

loadBrandFont();

const font = `${FONT_FAMILY}, system-ui, sans-serif`;
const msToFrames = (ms: number, fps: number) => Math.round((ms / 1000) * fps);

const TemplateScene: React.FC<{ scene: ReelScene; blue: string }> = ({ scene, blue }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const drift = interpolate(frame, [0, durationInFrames], [0, 1]);
  const text = scene.text.trim();
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1100px 900px at ${20 + drift * 55}% ${15 + drift * 20}%, #5a8cff 0%, transparent 62%), linear-gradient(165deg, #1e4fd6 0%, ${blue} 52%, #08090b 150%)`,
        fontFamily: font,
        justifyContent: "center",
        padding: "0 90px",
      }}
    >
      <div
        style={{
          color: "#fff",
          fontSize: text.length > 60 ? 100 : 128,
          fontWeight: 800,
          lineHeight: 1.03,
          letterSpacing: -3,
          transform: `translateY(${(1 - enter) * 48}px) scale(${1 + drift * 0.03})`,
          opacity: enter,
          textWrap: "balance",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const MediaScene: React.FC<{ scene: ReelScene }> = ({ scene }) => {
  const url = scene.assetUrl as string;
  const common: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  return (
    <AbsoluteFill style={{ background: "#08090b" }}>
      {scene.kind === "still" ? <Img src={url} style={common} /> : <OffthreadVideo src={url} muted style={common} />}
    </AbsoluteFill>
  );
};

const CaptionBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 330, paddingLeft: 70, paddingRight: 70 }}>
    <div
      style={{
        fontFamily: font,
        fontSize: 72,
        fontWeight: 800,
        lineHeight: 1.12,
        textAlign: "center",
        color: "#fff",
        textShadow: "0 4px 24px rgba(8,9,11,0.85), 0 1px 3px rgba(8,9,11,0.9)",
        background: "rgba(8,9,11,0.55)",
        borderRadius: 28,
        padding: "18px 34px",
        maxWidth: 940,
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

/** Karaoke captions: the voice's own word timings, the word being spoken highlighted. */
const KaraokeCaptions: React.FC<{ words: CaptionWord[]; blue: string }> = ({ words, blue }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chunks = React.useMemo(() => groupCaptionWords(words), [words]);
  const ms = (frame / fps) * 1000;
  const chunk = chunkAt(chunks, ms);
  if (!chunk) return null;
  const active = activeWordIndex(chunk, ms);
  return (
    <CaptionBox>
      {chunk.words.map((w, i) => (
        <span key={`${w.startMs}-${i}`} style={{ color: i === active ? "#8fb2ff" : "#fff", opacity: i <= active ? 1 : 0.78, marginRight: i < chunk.words.length - 1 ? 18 : 0, display: "inline-block", transform: i === active ? "scale(1.06)" : "none", textShadow: i === active ? `0 0 28px ${blue}` : undefined }}>
          {w.word}
        </span>
      ))}
    </CaptionBox>
  );
};

const SceneCaption: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div style={{ opacity }}>
      <CaptionBox>{text}</CaptionBox>
    </div>
  );
};

const EndCard: React.FC<{ mark: string }> = ({ mark }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ background: "#08090b", alignItems: "center", justifyContent: "center", fontFamily: font, color: "#fff" }}>
      <Img src={staticFile(mark)} style={{ width: 300, height: 300, transform: `scale(${0.85 + enter * 0.15})`, opacity: enter }} />
      <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: -2, marginTop: 40, opacity: enter }}>PropLane</div>
      <div style={{ fontSize: 56, fontWeight: 600, marginTop: 14, color: "#8fb2ff", opacity: enter }}>prop-lane.space</div>
    </AbsoluteFill>
  );
};

export const Reel: React.FC<ReelProps> = ({ scenes, voiceUrl, words, musicUrl, brand }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const endStart = msToFrames(scenesEndMs(scenes), fps);
  const hasWords = Boolean(words && words.length);
  return (
    <AbsoluteFill style={{ background: "#08090b" }}>
      {scenes.map((scene) => {
        const from = msToFrames(scene.startMs, fps);
        const dur = Math.max(1, msToFrames(scene.endMs, fps) - from);
        const media = scene.assetUrl && scene.kind !== "template" && !scene.fallback;
        return (
          <Sequence key={scene.index} from={from} durationInFrames={dur} layout="none">
            <AbsoluteFill>
              <Sequence layout="none">{media ? <MediaScene scene={scene} /> : <TemplateScene scene={scene} blue={brand.blue} />}</Sequence>
              {!hasWords && media && scene.text.trim() ? <SceneCaption text={scene.text.trim()} /> : null}
            </AbsoluteFill>
          </Sequence>
        );
      })}
      <Sequence from={endStart} durationInFrames={Math.max(1, durationInFrames - endStart)} layout="none">
        <EndCard mark={brand.mark} />
      </Sequence>
      {hasWords ? (
        <Sequence from={0} durationInFrames={durationInFrames} layout="none">
          <KaraokeCaptions words={words as CaptionWord[]} blue={brand.blue} />
        </Sequence>
      ) : null}
      {voiceUrl ? <Audio src={voiceUrl} /> : null}
      {musicUrl ? <Audio src={musicUrl} volume={0.15} loop /> : null}
    </AbsoluteFill>
  );
};
