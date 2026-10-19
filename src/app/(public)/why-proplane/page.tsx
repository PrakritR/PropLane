import { permanentRedirect } from "next/navigation";

/** The managed-service story now lives on the single-page front door. */
export default function WhyPropLanePage() {
  permanentRedirect("/#service");
}
