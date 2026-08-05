import { Document, parseDocument } from "yaml";

/**
 * yaml.Document 的一层薄包装：表单只读写自己负责的字段，
 * 注释、字段顺序、引号风格、未识别字段全部由 Document 原样保留。
 * 绝不做 parse → 普通对象 → stringify。
 */
export class FrontmatterDocument {
  private constructor(private doc: Document) {}

  static parse(raw: string): FrontmatterDocument {
    return new FrontmatterDocument(parseDocument(raw));
  }

  static empty(): FrontmatterDocument {
    return new FrontmatterDocument(new Document(new Map()));
  }

  /**
   * 表单编辑前先复制 Document，避免异步保存持有的旧 session 与当前表单共享同一个
   * 可变 yaml.Document。yaml 自带的 clone 会保留注释、节点样式和字段顺序。
   */
  clone(): FrontmatterDocument {
    return new FrontmatterDocument(this.doc.clone());
  }

  isEmpty(): boolean {
    const contents = this.doc.contents as { items?: unknown[] } | null;
    return (
      !contents || !Array.isArray(contents.items) || contents.items.length === 0
    );
  }

  /** 标量返回 JS 值，集合返回 toJSON 后的普通结构 */
  getValue(name: string): unknown {
    const v = this.doc.get(name);
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { toJSON?: unknown }).toJSON === "function"
    ) {
      return (v as { toJSON: () => unknown }).toJSON();
    }
    return v;
  }

  getString(name: string): string {
    const v = this.getValue(name);
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }

  getBoolean(name: string): boolean {
    return this.getValue(name) === true;
  }

  getTags(name: string): string[] {
    const v = this.getValue(name);
    return Array.isArray(v) ? v.map(String) : [];
  }

  set(name: string, value: unknown): void {
    this.doc.set(name, value);
  }

  delete(name: string): void {
    this.doc.delete(name);
  }

  toString(): string {
    return this.doc.toString();
  }
}
