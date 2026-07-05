export interface QueryTermNode {
  kind: "term";
  value: string;
  quoted: boolean;
  prefix: boolean;
}

export interface QueryAndNode {
  kind: "and";
  children: SearchQueryNode[];
}

export interface QueryOrNode {
  kind: "or";
  children: SearchQueryNode[];
}

export interface QueryAdjacencyNode {
  kind: "adjacency";
  children: QueryTermNode[];
}

export interface QueryNotNode {
  kind: "not";
  child: SearchQueryNode;
}

export type SearchQueryNode =
  | QueryTermNode
  | QueryAndNode
  | QueryOrNode
  | QueryAdjacencyNode
  | QueryNotNode;

export class SearchQuerySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQuerySyntaxError";
  }
}
