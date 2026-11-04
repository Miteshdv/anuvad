export type Language = {
  code: string;
  label: string;
  bcp47: string;
  flag: string;
};

export const LANGUAGES: Language[] = [
  { code: "en", label: "English", bcp47: "en-US", flag: "🇬🇧" },
  { code: "hi", label: "Hindi", bcp47: "hi-IN", flag: "🇮🇳" },
  { code: "es", label: "Spanish", bcp47: "es-ES", flag: "🇪🇸" },
  { code: "fr", label: "French", bcp47: "fr-FR", flag: "🇫🇷" },
  { code: "de", label: "German", bcp47: "de-DE", flag: "🇩🇪" },
  { code: "pt", label: "Portuguese", bcp47: "pt-BR", flag: "🇵🇹" },
  { code: "ja", label: "Japanese", bcp47: "ja-JP", flag: "🇯🇵" },
  { code: "ko", label: "Korean", bcp47: "ko-KR", flag: "🇰🇷" },
  { code: "zh", label: "Mandarin", bcp47: "zh-CN", flag: "🇨🇳" },
  { code: "ar", label: "Arabic", bcp47: "ar-SA", flag: "🇸🇦" },
];

export const DEFAULT_SOURCE = "en";
export const DEFAULT_TARGET = "hi";

export function languageByCode(code: string): Language | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
