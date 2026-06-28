declare const brandSymbol: unique symbol

export type Brand<Value, Name extends string> = Value & {
  readonly [brandSymbol]: Name
}

export const brandString = <Name extends string>(value: string): Brand<string, Name> =>
  value as Brand<string, Name>
