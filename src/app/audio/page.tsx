import AutomaticResearch from '@/components/casebook/AutomaticResearch';
import { automaticReadiness } from '@/lib/research/automatic-readiness';
export const dynamic = 'force-dynamic';
export default async function AudioPage() { return <AutomaticResearch kind="audio" readiness={await automaticReadiness('audio')} />; }
