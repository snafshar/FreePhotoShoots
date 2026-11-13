import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Silvergrain",
  description: "A black-and-white photography journal by Sina Afshar.",
  icons: { icon: "/static/favicon.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
