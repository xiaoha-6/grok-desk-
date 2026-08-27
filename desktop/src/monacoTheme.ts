import * as monaco from "monaco-editor";

export const MONACO_THEME_DARK = "grokdesk-dark";
export const MONACO_THEME_LIGHT = "grokdesk-light";

let registered = false;

export function registerMonacoThemes() {
  if (registered) return;
  registered = true;

  monaco.editor.defineTheme(MONACO_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#141414",
      "editor.foreground": "#D8D8D8",
      "editorGutter.background": "#141414",
      "editorLineNumber.foreground": "#5C5C5C",
      "editorLineNumber.activeForeground": "#A8A8A8",
      "editor.selectionBackground": "#264F7888",
      "editor.inactiveSelectionBackground": "#264F7844",
      "editor.lineHighlightBackground": "#FFFFFF08",
      "editorCursor.foreground": "#E6E6E6",
      "editorWidget.background": "#1C1C1C",
      "editorWidget.border": "#FFFFFF14",
      "scrollbarSlider.background": "#FFFFFF18",
      "scrollbarSlider.hoverBackground": "#FFFFFF28",
      "scrollbarSlider.activeBackground": "#FFFFFF33",
      "diffEditor.insertedTextBackground": "#3FB95066",
      "diffEditor.removedTextBackground": "#F8514966",
      "diffEditor.insertedLineBackground": "#1B433230",
      "diffEditor.removedLineBackground": "#5C1A1A30",
      "diffEditorGutter.insertedLineBackground": "#1B433255",
      "diffEditorGutter.removedLineBackground": "#5C1A1A55",
      "diffEditor.diagonalFill": "#00000000",
      "diffEditor.unchangedRegionBackground": "#1A1A1A",
      "diffEditor.unchangedRegionForeground": "#8A8A8A",
      "diffEditor.unchangedRegionShadow": "#00000000",
      "diffEditor.unchangedCodeBackground": "#141414",
      "diffEditor.border": "#00000000",
      "diffEditorOverview.insertedForeground": "#3FB95099",
      "diffEditorOverview.removedForeground": "#F8514999",
    },
  });

  monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#FBFBFC",
      "editor.foreground": "#1B1B1D",
      "editorGutter.background": "#FBFBFC",
      "editorLineNumber.foreground": "#8B8E96",
      "editorLineNumber.activeForeground": "#5C5F66",
      "editor.selectionBackground": "#B4D7FF88",
      "editor.lineHighlightBackground": "#11121408",
      "editorWidget.background": "#FFFFFF",
      "editorWidget.border": "#11121414",
      "diffEditor.insertedTextBackground": "#1A7F3744",
      "diffEditor.removedTextBackground": "#D1242F44",
      "diffEditor.insertedLineBackground": "#1A7F3714",
      "diffEditor.removedLineBackground": "#D1242F12",
      "diffEditorGutter.insertedLineBackground": "#1A7F3722",
      "diffEditorGutter.removedLineBackground": "#D1242F20",
      "diffEditor.diagonalFill": "#00000000",
      "diffEditor.unchangedRegionBackground": "#F2F3F5",
      "diffEditor.unchangedRegionForeground": "#5C5F66",
      "diffEditor.unchangedRegionShadow": "#00000000",
      "diffEditor.unchangedCodeBackground": "#FBFBFC",
      "diffEditor.border": "#00000000",
      "diffEditorOverview.insertedForeground": "#1A7F3788",
      "diffEditorOverview.removedForeground": "#D1242F88",
    },
  });
}
