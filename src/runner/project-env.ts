import { rejectShellInterpreterCommand, validateArgs, validateExecutable } from "./safety.js"

export type ProjectEnvironmentConfig = {
  readonly args: readonly string[]
  readonly command: string
}

export type RunnerCommandInvocation = {
  readonly args: readonly string[]
  readonly command: string
}

export const applyProjectEnvironment = (
  invocation: RunnerCommandInvocation,
  projectEnv: ProjectEnvironmentConfig | undefined,
): RunnerCommandInvocation => {
  if (projectEnv === undefined) {
    return invocation
  }
  validateExecutable(projectEnv.command, "project env")
  validateArgs(projectEnv.args, "project env")
  rejectShellInterpreterCommand(projectEnv.command, projectEnv.args, "project env")
  return {
    args: [...projectEnv.args, invocation.command, ...invocation.args],
    command: projectEnv.command,
  }
}
