import Watchlists from '@/components/casebook/Watchlists';
export default async function WatchPage({searchParams}: {searchParams: Promise<{case?: string}>}) {
  const params = await searchParams;
  return <Watchlists key={params.case ?? 'watchlist'} caseId={params.case} />;
}
