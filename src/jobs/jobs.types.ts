export interface Job {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: string | null;
  url: string;
  posted_at: string | null;
  description: string | null;
  easy_apply: boolean;
  applied: boolean;
  saved: boolean;
  scraped_at: string;
}

export interface JobSearchParams {
  keywords: string;
  location?: string;   // human-readable fallback (resolved via location-urns map)
  geoId?: string;      // LinkedIn numeric geoId — takes priority over location text
  remote?: boolean;
  easyApply?: boolean;
  datePosted?: 'past24h' | 'pastWeek' | 'pastMonth';
  limit?: number;
}
