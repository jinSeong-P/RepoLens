interface MermaidRenderResult {
  svg: string
}

interface MermaidApi {
  initialize(options: Record<string, unknown>): void
  render(id: string, definition: string): Promise<MermaidRenderResult>
}

declare global {
  var mermaid: MermaidApi
}

export {}
