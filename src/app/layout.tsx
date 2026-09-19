import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flash Flood | User testing before you have users",
  description: "A foundation for evidence-backed, persona-driven browser testing.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
