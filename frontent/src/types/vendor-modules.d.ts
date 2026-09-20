/**
 * 最小类型声明：这两个库在本项目里只用到下面几个入口。
 *
 * mammoth 既不自带类型、registry 里也没有 @types/mammoth；
 * pdfjs-dist 虽然带 types 字段，但在 moduleResolution: bundler 下裸导入解析不到，
 * 与其和它的 exports 映射较劲，不如只声明我们真正用到的部分。
 */
declare module 'mammoth' {
  export interface RawTextResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer;
  }): Promise<RawTextResult>;
  export function extractRawText(input: { path: string }): Promise<RawTextResult>;
}

declare module 'pdfjs-dist' {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src: {
    data: ArrayBuffer | Uint8Array;
  }): { promise: Promise<any> };
}
