/** Turn a real camera image into a PDF accepted by the existing document readers. */
export async function scanImageToPdf(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a document photo.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("Could not read this photo. Try a JPEG or PNG."));
      node.src = url;
    });
    const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This device could not scan the photo. Upload the file instead.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const photo = await pdf.embedJpg(canvas.toDataURL("image/jpeg", 0.85));
    const page = pdf.addPage([595.28, 841.89]);
    const fit = Math.min((page.getWidth() - 32) / photo.width, (page.getHeight() - 32) / photo.height);
    const width = photo.width * fit, height = photo.height * fit;
    page.drawImage(photo, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
    return new File([new Uint8Array(await pdf.save())], `${file.name.replace(/\.[^.]+$/, "") || "Scan"}.pdf`, { type: "application/pdf" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
