import * as p from "@clack/prompts";
import type { Option as ClackOption } from "@clack/prompts";
import { UserCancelledError, UserFacingError } from "../types.js";

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface PromptApi {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  step(message: string): void;
  select<T>(message: string, options: SelectOption<T>[], initialValue?: T): Promise<T>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  text(message: string, initialValue?: string): Promise<string>;
  stage<T>(
    message: string,
    task: () => Promise<T>,
    labels?: { success?: string; error?: string },
  ): Promise<T>;
}

export function createPromptApi(forceInteractive?: boolean): PromptApi {
  const interactive =
    forceInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !p.isCI());

  const assertInteractive = () => {
    if (!interactive) {
      throw new UserFacingError(
        "This step requires an interactive terminal, but no TTY is available.",
      );
    }
  };

  const resolveValue = <T>(value: T | symbol): T => {
    if (p.isCancel(value)) {
      p.cancel("Operation cancelled.");
      throw new UserCancelledError();
    }
    return value;
  };

  return {
    interactive,

    intro(title: string): void {
      if (interactive) {
        p.intro(title);
      }
    },

    outro(message: string): void {
      if (interactive) {
        p.outro(message);
      }
    },

    info(message: string): void {
      p.log.info(message);
    },

    warn(message: string): void {
      p.log.warn(message);
    },

    step(message: string): void {
      p.log.step(message);
    },

    async select<T>(message: string, options: SelectOption<T>[], initialValue?: T): Promise<T> {
      assertInteractive();
      const selectOptions = options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.hint,
        disabled: option.disabled,
      })) as ClackOption<T>[];
      const value = await p.select<T>({
        message,
        options: selectOptions,
        initialValue,
      });
      return resolveValue(value);
    },

    async confirm(message: string, initialValue = true): Promise<boolean> {
      assertInteractive();
      const value = await p.confirm({
        message,
        initialValue,
      });
      return resolveValue(value);
    },

    async text(message: string, initialValue = ""): Promise<string> {
      assertInteractive();
      const value = await p.text({
        message,
        initialValue,
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return "Value is required";
          }
          return undefined;
        },
      });
      return resolveValue(value).trim();
    },

    async stage<T>(
      message: string,
      task: () => Promise<T>,
      labels?: { success?: string; error?: string },
    ): Promise<T> {
      if (!interactive) {
        console.error(message);
        return task();
      }

      const s = p.spinner();
      s.start(message);
      try {
        const result = await task();
        s.stop(labels?.success ?? message);
        return result;
      } catch (error) {
        s.error(labels?.error ?? message);
        throw error;
      }
    },
  };
}
