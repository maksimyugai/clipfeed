// Minimal ambient types for the chrome.* extension APIs this codebase
// actually calls. No @types/chrome dependency — the forkability policy's
// dependency list for this package is preact + @mozilla/readability only.
declare global {
  namespace chrome.scripting {
    interface InjectionTarget {
      tabId: number;
    }

    interface ScriptInjection<Args extends unknown[], Result> {
      target: InjectionTarget;
      files?: string[];
      func?: (...args: Args) => Result;
      args?: Args;
    }

    interface InjectionResult<Result> {
      result: Result;
      frameId: number;
    }

    function executeScript<Args extends unknown[] = [], Result = unknown>(
      injection: ScriptInjection<Args, Result>,
    ): Promise<InjectionResult<Result>[]>;
  }

  namespace chrome.storage.local {
    function get(keys: string[]): Promise<Record<string, unknown>>;
    function set(items: object): Promise<void>;
    function remove(keys: string | string[]): Promise<void>;
  }

  namespace chrome.runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
    }

    function sendMessage<Response = unknown>(message: unknown): Promise<Response>;
    function openOptionsPage(): Promise<void>;

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }

  namespace chrome.tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }

    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function create(createProperties: { url: string }): Promise<Tab>;
  }

  namespace chrome.action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }

  namespace chrome.permissions {
    interface Permissions {
      origins?: string[];
    }

    function request(permissions: Permissions): Promise<boolean>;
    function contains(permissions: Permissions): Promise<boolean>;
  }
}

export {};
