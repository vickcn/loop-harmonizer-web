import { Manrope, Space_Grotesk } from "next/font/google";

export const mixerHeadingFont = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-grotesk",
  preload: true,
});

export const mixerInterfaceFont = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
  preload: true,
});

export const mixerFontVariableClasses = `${mixerHeadingFont.variable} ${mixerInterfaceFont.variable}`;
