export type Bindings = Cloudflare.Env;

export type Status = "pending" | "approved" | "suspended" | "declined";
export type Member = {
  id: string; site_user_id: string; email: string; handle: string; name: string; bio: string; location: string;
  public_email: string; public_phone: string; note: string; status: Status; revision: number; created_at: number; updated_at: number;
};
export type Settings = {
  name: string; email: string; phone: string; hide_samples: string;
  owner_id?: string; handle?: string; bio?: string; location?: string;
  magazine_title?: string; paper?: string; typeface?: string; spacing?: string; applications?: string;
};
export function memberMagazine(site: Settings, member: Member): Settings {
  return { ...site, owner_id: member.id, handle: member.handle, name: member.name, bio: member.bio,
    location: member.location, email: member.public_email, phone: member.public_phone, hide_samples: "1" };
}
export const ownerHandle = "sina-afshar";
export const magazineBase = (site: Settings) => site.handle ? "/" + site.handle : "";
export const papers: Record<string, [string, string]> = { cream: ["Cream", "#f7f2e8"], white: ["White", "#ffffff"], linen: ["Linen", "#ede9df"], mist: ["Mist", "#eef1ef"] };
export const typefaces = { editorial: "Instrument Serif", classic: "Georgia", modern: "Inter" };
export const spacings = { spacious: "Spacious", compact: "Compact" };
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
  owner_id?: string | null;
  author_handle?: string | null;
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
  author_handle?: string | null;
  id: number;
  name: string;
  email: string;
  body: string;
  created_at: number;
  read_at: number | null;
};
export type StoryInput = Pick<Story, "title" | "caption" | "story" | "category" | "location" | "photo_date">;
