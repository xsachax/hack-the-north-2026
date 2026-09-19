import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flash Flood | User testing before you have users",
  description: "Scoped persona missions, real cloud browsers, and evidence-backed live logs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
