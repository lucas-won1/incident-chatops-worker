export const workerCommands = ["daemon", "doctor", "status", "run-once", "logs"] as const

export type WorkerCommand = (typeof workerCommands)[number]

export const isWorkerCommand = (value: string): value is WorkerCommand =>
  workerCommands.includes(value as WorkerCommand)
