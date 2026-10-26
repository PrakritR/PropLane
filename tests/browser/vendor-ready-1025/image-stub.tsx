/** `next/image` → a plain <img>. The panels use it for photo thumbnails only. */
import React from "react";

export default function Image(
  props: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string; fill?: boolean; unoptimized?: boolean; priority?: boolean },
) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { fill: _f, unoptimized: _u, priority: _p, ...rest } = props;
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...rest} />;
}
