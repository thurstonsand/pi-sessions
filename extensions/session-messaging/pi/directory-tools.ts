import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionDirectory } from "../directory.ts";
import { createSessionListTool, type ListToolOptions } from "./list-tool.ts";
import {
  createSessionCancelTool,
  createSessionSendMessageTool,
  type SendMessageToolWording,
} from "./tools.ts";

export interface DirectoryToolWording {
  list: ListToolOptions;
  send: SendMessageToolWording & { name: string };
  cancel: SendMessageToolWording & { name: string };
}

/** Both public tool sets share execution, validation and native rendering. */
export function createDirectoryTools(
  directory: SessionDirectory,
  wording: DirectoryToolWording,
): ToolDefinition[] {
  return [
    createSessionListTool(directory, wording.list),
    createSessionSendMessageTool(
      { sendMessage: directory.send },
      {
        name: wording.send.name,
        wording: wording.send,
        getCachedRelationTo: directory.getRelationTo,
        getParentSessionId: directory.getParentSessionId,
      },
    ),
    createSessionCancelTool(
      { cancelSession: directory.cancel },
      {
        name: wording.cancel.name,
        wording: wording.cancel,
        getParentSessionId: directory.getParentSessionId,
      },
    ),
  ];
}
