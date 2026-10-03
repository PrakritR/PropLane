import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFImage } from "pdf-lib";
import { getMoveInFormForExport, MOVE_IN_FORM_FILES_BUCKET, MoveInFormError, type MoveInFormActor } from "./server";
import { formatPacificDate } from "@/lib/pacific-time";
import type { MoveInFormAnswer, MoveInFormQuestion } from "./types";

/** "Oct 3, 2026, 4:07 PM PT": the export prints people's time, never a raw ISO string. */
function pacificStamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  const text = formatPacificDate(iso, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return text === "\u2014" ? "-" : `${text} PT`;
}

function pacificDay(iso: string | null | undefined): string {
  if (!iso) return "-";
  const text = formatPacificDate(iso, { month: "short", day: "numeric", year: "numeric" });
  return text === "\u2014" ? "-" : text;
}

function answerText(question: MoveInFormQuestion, answer: MoveInFormAnswer | undefined): string {
  if (!answer) return "No answer";
  if ("files" in answer) return answer.files.length ? `${answer.files.length} photo${answer.files.length === 1 ? "" : "s"} attached` : "No answer";
  if ("signature" in answer) return `Signed by ${answer.signature.signedName} on ${pacificDay(answer.signature.signedAt)}`;
  const value = answer.value;
  if (value === true || value === "yes") return question.type === "checkbox" ? "Checked" : "Yes";
  if (value === false || value === "no") return question.type === "checkbox" ? "Not checked" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "No answer";
  return value == null || value === "" ? "No answer" : String(value);
}

/** Exports the saved submission; never accepts a client-authored document or storage path. */
export async function moveInFormPdf(actor: MoveInFormActor, id: string): Promise<Uint8Array> {
  const record = (await getMoveInFormForExport(actor, id));
  if (record.status !== "submitted") throw new MoveInFormError("Only a submitted form can be downloaded.", 409);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 748;
  const clean = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\n]/g, "?");
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
  const storage = actor.context.db.storage.from(MOVE_IN_FORM_FILES_BUCKET);
  const image = async (path: string): Promise<PDFImage> => {
    const { data, error } = await storage.download(path);
    if (error || !data) throw new MoveInFormError("A form image could not be downloaded. Retry the export.", 500);
    const bytes = await data.arrayBuffer();
    return path.toLowerCase().endsWith(".png") ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
  };
  const images = async (paths: string[], fit: [number, number]) => {
    for (let index = 0; index < paths.length; index += 3) {
      space(fit[1] + 36);
      for (const [n, path] of paths.slice(index, index + 3).entries()) {
        const embedded = await image(path);
        const size = embedded.scaleToFit(fit[0], fit[1]);
        page.drawImage(embedded, { x: 46 + n * (fit[0] + 12), y: y - fit[1], width: size.width, height: size.height });
      }
      y -= fit[1] + 14;
    }
  };

  line(`PropLane | ${record.formName}`, true);
  line(`${record.residentName} | ${record.propertyLabel}${record.roomLabel ? ` | ${record.roomLabel}` : ""}`);
  line(`Submitted: ${pacificStamp(record.submittedAt)} | Sent: ${pacificStamp(record.sentAt)}${record.dueAt ? ` | Due: ${pacificDay(record.dueAt)}` : ""}`);
  line(`Form: ${record.id} | Residency: ${record.applicationId}`);
  if (record.signedDocumentSha256) line(`Signed document SHA-256: ${record.signedDocumentSha256}`);
  if (record.snapshot.pdf) line(`Document: ${record.snapshot.pdf.fileName} (${record.snapshot.pdf.pageCount} page${record.snapshot.pdf.pageCount === 1 ? "" : "s"})`);
  y -= 10;

  const byKey = new Map(record.answers.map((answer) => [answer.key, answer]));
  let section: string | undefined;
  for (const question of record.snapshot.questions) {
    const answer = byKey.get(question.key);
    // A question hidden by its condition has no answer and was never asked.
    if (!answer && question.showIf) continue;
    if (question.section && question.section !== section) { section = question.section; space(40); line(section, true); }
    space(40);
    line(question.label, true);
    line(answerText(question, answer));
    if (answer && "files" in answer) await images(answer.files, [162, 112]);
    if (answer && "signature" in answer) await images([answer.signature.storagePath], [200, 70]);
    y -= 6;
  }
  for (const [index, sheet] of pdf.getPages().entries()) {
    sheet.drawText(`PropLane move-in form | ${index + 1} / ${pdf.getPageCount()}`, { x: 46, y: 25, size: 8, font, color: rgb(.4, .4, .4) });
  }
  return pdf.save();
}
