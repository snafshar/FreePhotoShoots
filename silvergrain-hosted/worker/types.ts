export type Bindings = Cloudflare.Env;

export type Settings = { name: string; email: string; phone: string; hide_samples: string };
export type Photo = {
  id: string;
  alt: string;
  caption: string;
  title?: string | null;
  story?: string | null;
  width: number;
  height: number;
  full?: string;
  small?: string;
};
export type Story = {
  id: string;
  slug: string;
  title: string;
  caption: string;
  story: string;
  category: string;
  location: string;
  photo_date: string;
  published_at: number | null;
  updated_at: number;
  revision: number;
  demo?: boolean;
};
export type Card = Story & { photo?: Photo; photo_count: number };
export type MagazinePhoto = Photo & {
  post_id: string;
  slug: string;
  title: string;
  category: string;
  location: string;
  photo_date: string;
  demo?: boolean;
};
export type Message = {
  id: number;
  name: string;
  email: string;
  body: string;
  created_at: number;
  read_at: number | null;
};
export type StoryInput = Pick<Story, "title" | "caption" | "story" | "category" | "location" | "photo_date">;
