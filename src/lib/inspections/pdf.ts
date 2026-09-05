import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getInspection, INSPECTION_BUCKET, type InspectionActor } from "./server";
import { inspectionRoomLabel, INSPECTION_CONDITIONS, InspectionError, type InspectionObservation } from "./model";

/** Exports the saved snapshot; never accepts a client-authored document or storage path. */
export async function inspectionPdf(actor: InspectionActor, id: string): Promise<Uint8Array> {
  const report = await getInspection(actor, id);
  const baseline = report.baseline_id ? await getInspection(actor, report.baseline_id) : null;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 748;
  const clean = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e\n]/g, "?");
  const space = (height: number) => { if (y - height < 50) { page = pdf.addPage([612, 792]); y = 748; } };
  const line = (value: string, heading = false) => {
    const face = heading ? bold : font;
    const size = heading ? 12 : 10;
    for (const paragraph of clean(value).split("\n")) {
      let text = "";
      for (const char of paragraph) {
        if (face.widthOfTextAtSize(text + char, size) > 520) {
          space(16); page.drawText(text, { x: 46, y, size, font: face }); y -= 15; text = "";
        }
        text += char;
      }
      space(16); page.drawText(text, { x: 46, y, size, font: face }); y -= 16;
    }
  };
  line(`PropLane | ${report.kind === "move-in" ? "Move-in" : "Move-out"} inspection`, true);
  line(`${report.resident_name} | ${report.property_label} | ${inspectionRoomLabel(report.room_label) || "Property"}`);
  line(`Inspection date: ${report.inspection_date} | Status: ${report.status} | Revision: ${report.revision}`);
  line(`Report: ${report.id} | Residency: ${report.application_id}`);
  if (baseline) line(`Move-in baseline: ${baseline.inspection_date} (${baseline.id})`);
  else if (report.kind === "move-out") line("No move-in baseline attached. This report alone does not establish when damage occurred.");
  line("Observations document condition. Acknowledgment confirms review, not agreement with charges or liability.");
  line("Deposit decisions and charges are handled separately. Unchecked items have not been assessed.");
  y -= 12;
  const baselineItems = new Map(baseline?.document.areas.flatMap(a => a.items).map(i => [i.id, i]) ?? []);
  const observation = async (label: string, value: InspectionObservation) => {
    line(`${label}: ${INSPECTION_CONDITIONS[value.condition]}${value.notes ? ` - ${value.notes}` : ""}`);
    for (let index = 0; index < value.photos.length; index += 3) {
      space(150);
      const photos = value.photos.slice(index, index + 3);
      for (let n = 0; n < photos.length; n++) {
        const photo = photos[n]!;
        const { data, error } = await actor.context.db.storage.from(INSPECTION_BUCKET).download(photo.path);
        if (error || !data) throw new InspectionError("A report photo could not be downloaded. Retry the export.", 500);
        const image = await pdf.embedJpg(await data.arrayBuffer());
        const size = image.scaleToFit(162, 112);
        page.drawImage(image, { x: 46 + n * 174, y: y - 115, width: size.width, height: size.height });
        page.drawText(photo.uploadedAt.slice(0, 10), { x: 46 + n * 174, y: y - 128, size: 8, font });
      }
      y -= 146;
    }
  };
  let matchedBaselineItem = false;
  for (const area of report.document.areas) {
    space(60); line(area.label, true);
    for (const item of area.items) {
      // A room section holds one item named after the section itself, so printing
      // both headings repeats the same line back at the reader.
      if (area.items.length > 1 || item.label !== area.label) { space(60); line(item.label, true); }
      const previous = baselineItems.get(item.id);
      if (previous) {
        matchedBaselineItem = true;
        await observation("Move-in / manager", previous.manager);
        await observation("Move-in / resident", previous.resident);
      }
      await observation(`${report.kind} / manager`, item.manager);
      await observation(`${report.kind} / resident`, item.resident);
      y -= 7;
    }
  }
  // A room-scoped report references a legacy 15-area baseline whose item ids no
  // longer line up, so nothing above matched. The move-in evidence still exists and
  // the portal shows it — print the PRIVATE ROOM section of it here rather than
  // exporting a move-out report with its baseline silently missing. Shared property
  // areas stay out: this inspection covers the assigned room only.
  const legacyBaselineRoom = baseline && !matchedBaselineItem
    ? baseline.document.areas.filter(area => area.id === "area-0").flatMap(area => area.items)
    : [];
  if (legacyBaselineRoom.length > 0) {
    space(60); line(`Move-in baseline (original report, ${baseline!.inspection_date}) - private room`, true);
    line("Item names differ from this report's sections because the baseline used the earlier property-wide form.");
    for (const item of legacyBaselineRoom) {
      space(60); line(item.label, true);
      await observation("Move-in / manager", item.manager);
      await observation("Move-in / resident", item.resident);
      y -= 7;
    }
  }
  line("Record history", true);
  for (const event of report.document.history) line(`${event.at} | ${event.role} | ${event.action} | ${event.userId}`);
  const acknowledgment = report.document.residentAcknowledgment;
  line(acknowledgment ? `Resident acknowledged review at ${acknowledgment.at}. User: ${acknowledgment.userId}` : "Resident acknowledgment: pending.");
  for (const [index, sheet] of pdf.getPages().entries()) {
    sheet.drawText(`PropLane inspection | ${index + 1} / ${pdf.getPageCount()}`, { x: 46, y: 25, size: 8, font, color: rgb(.4, .4, .4) });
  }
  return pdf.save();
}
