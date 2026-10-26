import { redirect } from "next/navigation";
import { linkedFormOpenPath } from "@/lib/linked-form-path";

export default async function LegacyLinkedFormPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  redirect(linkedFormOpenPath(requestId));
}
