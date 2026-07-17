export interface RenderTheme {
  bold(text: string): string;
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}
