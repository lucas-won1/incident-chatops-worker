export const findOptionValue = (
  args: readonly string[],
  optionName: string,
): string | undefined => {
  const optionIndex = args.indexOf(optionName)
  switch (optionIndex) {
    case -1:
      return undefined
    default:
      return args[optionIndex + 1]
  }
}
