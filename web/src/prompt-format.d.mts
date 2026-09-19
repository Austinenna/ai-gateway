export type PromptNode = { type: 'text'; raw: string } | {
  type: 'section'; raw: string; tag: string; label: string; attributes: string; body: string;
  children: PromptNode[]; collapsed: boolean;
};
export function promptSections(text: string, depth?: number): PromptNode[];
export function frontMatterAsCode(text: string): string;
export function environmentFields(text: string): {name: string; value: string}[] | null;
export function hasPromptFormatting(text: string): boolean;
