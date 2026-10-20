/**
 * The editor for the Files view. Loaded lazily by FilesView, so Monaco stays out
 * of the home bundle: this module pulls in lib/monaco (the whole editor).
 */
import Editor from "@monaco-editor/react";
import { baseOptions, defineKohlabTheme, useMonacoTheme } from "../../lib/monaco";
import { languageForFile } from "../../lib/diff";

interface Props {
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

export default function CodeEditor({ path, value, readOnly, onChange }: Props) {
  const theme = useMonacoTheme();
  return (
    <Editor
      height="100%"
      path={path}
      language={languageForFile(path)}
      value={value}
      beforeMount={defineKohlabTheme}
      theme={theme}
      onChange={(next) => onChange(next ?? "")}
      options={{
        ...baseOptions(),
        readOnly,
        ariaLabel: `contents of ${path}`,
      }}
    />
  );
}
