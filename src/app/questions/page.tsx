import AutomaticResearch from '@/components/casebook/AutomaticResearch';
import { automaticReadiness } from '@/lib/research/automatic-readiness';
export const dynamic = 'force-dynamic';
export default async function QuestionsPage() { return <AutomaticResearch kind="topic" readiness={await automaticReadiness('topic')} />; }
