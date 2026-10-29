import { SectionNotFound } from "../../section-not-found";

export default function ImportNotFound() {
  return <SectionNotFound message="That import no longer exists." backLabel="Back to imports" section="imports" />;
}
