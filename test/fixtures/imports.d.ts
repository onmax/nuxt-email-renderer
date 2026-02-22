declare module '#imports' {
  export function renderEmailComponent(
    componentName: string,
    props?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}
