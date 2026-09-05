import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import {
  ClientSideRowModelModule,
  ModuleRegistry,
  TextFilterModule,
  themeQuartz,
  type GetRowIdParams,
} from "ag-grid-community";
import type { RouterOutputs } from "@/server/api";

ModuleRegistry.registerModules([ClientSideRowModelModule, TextFilterModule]);

type Section = RouterOutputs["user"]["getWatchedClasses"][number];

const getRowId = ({ data }: GetRowIdParams<Section>) => data.id;

export default function WatchedClassesGrid(props: AgGridReactProps<Section>) {
  return <AgGridReact<Section> theme={themeQuartz} getRowId={getRowId} {...props} />;
}
