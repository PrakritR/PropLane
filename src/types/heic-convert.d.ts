declare module "heic-convert" {
  type Options = { buffer: Buffer | ArrayBufferLike | Uint8Array; format: "JPEG" | "PNG"; quality?: number };
  /** Decodes HEIC/HEIF (HEVC) in pure JS/WASM; sharp's prebuilt libvips cannot. Resolves to an ArrayBuffer view. */
  const convert: (options: Options) => Promise<ArrayBuffer | Uint8Array>;
  export default convert;
}
