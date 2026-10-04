export type RowMessage = { row: number | null; message: string; code?: "missing_email" };

export type ParsedParticipant = {
  row: number;
  email: string;
  firstName: string;
  lastName: string;
  organization: string | null;
  title: string | null;
  /** Null when the column is absent or the cell is blank: keep the current value. */
  biztechOptIn: boolean | null;
};

export type ParsedSupplier = {
  row: number;
  name: string;
  type: "business" | "hotel";
  adminContactName: string | null;
  adminContactEmail: string | null;
  attendeeContactName: string | null;
  attendeeContactEmail: string | null;
};

export type RankingChoice = {
  /** The CHOICE #n column number. Ordinal position is the rank. */
  rank: number;
  targetName: string;
};

export type ParsedRankingListRow = {
  row: number;
  rankerName: string;
  rankerEmail: string | null;
  choices: RankingChoice[];
};

export type MatrixCell = {
  targetName: string;
  rank: number | null;
  /** Only an explicit N/A sets this (D2). */
  isRejection: boolean;
};

export type ParsedRankingMatrixRow = {
  row: number;
  rankerName: string;
  cells: MatrixCell[];
};

export type ParsedRows<T> = {
  rows: T[];
  /** Row-level problems that excluded the row from `rows`. */
  errors: RowMessage[];
};

export type ParsedFile =
  | { kind: "participants"; format: "template"; rows: ParsedParticipant[]; errors: RowMessage[] }
  | { kind: "suppliers"; format: "template"; rows: ParsedSupplier[]; errors: RowMessage[] }
  | { kind: "ranking"; format: "list"; rows: ParsedRankingListRow[]; errors: RowMessage[] }
  | { kind: "ranking"; format: "matrix"; rows: ParsedRankingMatrixRow[]; errors: RowMessage[] };
