import { Suspense } from "react";
import Casebook from "@/components/casebook/Casebook";
export default function CasebookPage() { return <Suspense fallback={<main className="casebook-main">Opening the casebook…</main>}><Casebook /></Suspense>; }
