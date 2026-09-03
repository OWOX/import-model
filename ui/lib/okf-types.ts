export type InputSource = "SQL" | "CONNECTOR" | "VIEW" | "TABLE";
export type NodeStatus = "pending" | "creating" | "created" | "error";
export type Cardinality = "1:1" | "1:N" | "N:1" | "N:N";

export interface SchemaField { name: string; type: string; pk: boolean; alias?: string; description?: string; }
export interface JoinKey { left: string; right: string; }

/**
 * A join node deeper than one hop: what the reporting column picker calls it, and what it
 * means from the mart that reaches it.
 *
 * The picker is one flat list, and a mart can reach the same target twice — Invoices joins
 * Account directly and again through Subscription. Two sources both reading "Account" are
 * indistinguishable, and one sentence written for the edge cannot be right for both. ODM
 * therefore lets each node override both, and an OKF bundle writes them as the nested
 * bullets of its Joins section.
 */
export interface JoinNode {
  /** Mart keys from the mart that owns the Joins section: ["subscription", "account"]. */
  path: string[];
  /** The mart this node points at — the last hop of `path`. */
  targetKey: string;
  /** Label shown in the column picker and in report column headers. */
  alias: string;
  description?: string;
}

export interface ModelNode {
  key: string;
  title: string;
  inputSource: InputSource;
  description?: string;
  definition?: string | null;   // optional source definition (SQL / table ref / view)
  schema: SchemaField[];
  /** Join nodes below depth one, in the order the bundle lists them. */
  joinNodes?: JoinNode[];
  position: { x: number; y: number };
  status: NodeStatus;
  owoxId?: string | null;
  // The OWOX storage this owoxId lives in. Push treats a "created" mart as
  // already-in-OWOX only when this matches the active storage, so switching
  // project/storage recreates a stale mart instead of silently skipping it.
  owoxStorageId?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  error?: string | null;
}
export interface ModelEdge {
  id: string;
  from: string;
  to: string;
  keys: JoinKey[];
  bidirectional: boolean;
  cardinality?: Cardinality;
  /** What the edge MEANS, from the source mart's side — ODM stores it on the relationship. */
  description?: string;
  /** The same, for the other direction of a bidirectional edge, which is its own relationship. */
  reverseDescription?: string;
  /** A display label for the target that the bundle wrote by hand (not just the mart title). */
  targetLabel?: string;
  // Canvas-only hints for which ports the edge attaches to (not encoded in OKF).
  sourceHandle?: string | null;
  targetHandle?: string | null;
  // True for edges imported from OWOX (already exist there) — push skips them.
  existing?: boolean;
}
export interface ModelGraph {
  storageId: string | null;
  nodes: ModelNode[];
  edges: ModelEdge[];
}
