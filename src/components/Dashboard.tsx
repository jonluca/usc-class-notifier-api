import { api } from "@/utils/api";
import { LinearProgress, TextField, Typography } from "@mui/material";
import React, { useMemo, useState } from "react";
import type { RouterOutputs } from "@/server/api";
import type { AgGridReactProps } from "ag-grid-react";
import { AgGridReact } from "ag-grid-react";
import { ClientSideRowModelModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { getValidSemesters } from "@/utils/semester";
import { SettingEntry } from "@/components/SettingsEntry";
import { toast } from "react-toastify";
import PencilIcon from "@mui/icons-material/Edit";
import Close from "@mui/icons-material/Close";
import Save from "@mui/icons-material/Check";
import LinkIcon from "@mui/icons-material/Link";
import Link from "next/link";
import Cookies from "js-cookie";
import { cookieKey } from "@/server/auth";
ModuleRegistry.registerModules([ClientSideRowModelModule]);
type Section = RouterOutputs["user"]["getWatchedClasses"][number];
type ColDef = AgGridReactProps<Section>["columnDefs"];
const defaultColDef: NonNullable<ColDef>[number] = {
  width: 130,
  sortable: true,
  filter: true,
};

const NotifyButton = ({ data }: { data: Section }) => {
  const utils = api.useUtils();
  const { mutateAsync, isPending } = api.user.continueReceivingNotificationsForSection.useMutation();

  if (!data || !data.notified) {
    return null;
  }
  // check if it's in the past
  const semester = data.semester;
  if (semester) {
    const year = semester.slice(0, 4);
    const currentYear = new Date().getFullYear();
    // we could be smarter and do per semester but this is fine
    if (parseInt(year) < currentYear) {
      return null;
    }
  }
  const submit = async () => {
    await toast.promise(mutateAsync({ id: data.id }), {
      pending: "Re-notifying",
      success: "Re-notified",
      error: "Failed to re-notify",
    });
    await utils.user.invalidate();
  };

  return (
    <button
      className="inline-flex py-1 items-center justify-center rounded-md bg-gray-900 px-3 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
      disabled={isPending}
      onClick={submit}
    >
      Re-Notify
    </button>
  );
};
const iconStyle = { fontSize: 14, cursor: "pointer" };

const PhoneOverride = ({ data }: { data: Section }) => {
  const [isEdit, setIsEdit] = useState(false);
  const [phone, setPhone] = useState(data.phoneOverride || "");
  const { mutateAsync } = api.user.changePhoneNumberForSection.useMutation();
  const utils = api.useUtils();

  if (isEdit) {
    return (
      <span className={"flex items-center gap-2"}>
        <Close sx={iconStyle} onClick={() => setIsEdit(false)} />
        <Save
          sx={iconStyle}
          onClick={async () => {
            if (phone.length !== 10) {
              toast.error("Phone number must be 10 digits");
              return;
            }
            await toast.promise(mutateAsync({ id: data.id, phoneNumber: phone }), {
              pending: "Saving",
              success: "Saved",
              error: "Failed to save",
            });
            await utils.user.invalidate();
            setIsEdit(false);
          }}
        />
        <input
          type="text"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
      </span>
    );
  }
  return (
    <span className={"flex h-full gap-2 items-center"}>
      {data.phoneOverride || ""}
      <PencilIcon sx={iconStyle} onClick={() => setIsEdit(true)} />
    </span>
  );
};

const VenmoLink = ({ data }: { data: Section }) => {
  return (
    <Link href={`https://account.venmo.com/pay?recipients=JonLuca&amount=1&note=${data.paidId}`} target={"_blank"}>
      <span className={"flex h-full gap-2 items-center"}>
        {data.paidId || ""}
        <LinkIcon sx={iconStyle} />
      </span>
    </Link>
  );
};

const columns = [
  // { headerName: "Department", field: "ClassInfo.department" },
  { headerName: "Section", field: "section", width: 100 },
  { headerName: "Course", field: "ClassInfo.courseNumber", width: 120 },
  { headerName: "Semester", field: "semester", initialSort: "desc", width: 137 },
  { headerName: "Notified", field: "notified", width: 90, filter: false },
  { headerName: "Venmo ID", field: "paidId", width: 113, cellRenderer: VenmoLink },
  { headerName: "Phone", field: "phoneOverride", cellRenderer: PhoneOverride, width: 160 },
  { headerName: "Paid", field: "isPaid", width: 80, filter: false },
  { headerName: "Notify", field: "notified", cellRenderer: NotifyButton },
] as ColDef;

const EditPhoneGlobal = () => {
  const { data: userInfo } = api.user.getUserInfo.useQuery();

  const [isEdit, setIsEdit] = useState(false);
  const [phone, setPhone] = useState(userInfo?.phone || "");
  const { mutateAsync } = api.user.changePhoneNumberForAccount.useMutation();
  const utils = api.useUtils();

  if (isEdit) {
    return (
      <span className={"flex items-center gap-2"}>
        <Close sx={iconStyle} onClick={() => setIsEdit(false)} />
        <Save
          sx={iconStyle}
          onClick={async () => {
            if (phone.length !== 10) {
              toast.error("Phone number must be 10 digits");
              return;
            }
            await toast.promise(mutateAsync({ phoneNumber: phone }), {
              pending: "Saving",
              success: "Saved",
              error: "Failed to save",
            });
            await utils.user.invalidate();
            setIsEdit(false);
          }}
        />
        <input
          type="text"
          value={phone}
          className="w-full h-12 px-4 text-sm text-gray-900 placeholder-gray-500 bg-gray-100 border-2 border-gray-100 rounded-lg"
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
      </span>
    );
  }

  if (!userInfo) {
    return null;
  }
  return (
    <span className={"flex h-full gap-2 items-center"}>
      {userInfo.phone || ""}
      <PencilIcon sx={iconStyle} onClick={() => setIsEdit(true)} />
    </span>
  );
};

const AdminEmailSetter = () => {
  const [email, setEmail] = useState("");
  const { mutateAsync } = api.admin.getUserKey.useMutation();
  const utils = api.useUtils();

  return (
    <div className="flex flex-col items-center gap-4 bg-gray-100 rounded-xl p-2 w-[400px]">
      <Typography variant="body2" className="font-bold text-neutral-400 text-xs ml-4 -mb-3 w-full">
        Email
      </Typography>
      <TextField
        className={`flex w-full bg-white rounded-xl`}
        size="small"
        variant="outlined"
        sx={{
          ".MuiOutlinedInput-notchedOutline": { border: 0 },
          ".MuiOutlinedInput-root": { paddingY: 0.3 },
          ".MuiInputBase-input": { fontSize: 16, fontWeight: "bold" },
        }}
        placeholder={"Email"}
        onChange={(e) => {
          // Ensure the length isn't over 35 characters
          if (e.target.value.length > 35) {
            return;
          }
          setEmail(e.target.value);
        }}
        onKeyDown={async (e) => {
          // Handle enter key
          if (e.key === "Enter") {
            const data = await mutateAsync({ email });
            if (!data) {
              alert("No user found");
              return;
            }
            // set document.cookie of key to users verification key and refresh all

            Cookies.set(cookieKey, data.verificationKey, {
              path: "/",
            });
            await utils.invalidate();

            return;
          }
        }}
        value={email}
      />
    </div>
  );
};
export default function Dashboard({
  isAdmin,
  didSucceedInWatchingSection,
  section,
}: {
  didSucceedInWatchingSection?: boolean;
  section?: string;
  isAdmin?: boolean;
}) {
  const { data, isLoading } = api.user.getWatchedClasses.useQuery();
  const { data: userInfo } = api.user.getUserInfo.useQuery();
  const [showOldSemesters, setShowOldSemesters] = useState(false);
  const { mutateAsync, isPending } = api.user.setAccountLevelPhoneToAllSections.useMutation();
  const utils = api.useUtils();

  const setAccountLevelPhoneToAllSections = async () => {
    await toast.promise(mutateAsync(), {
      pending: "Setting phone number",
      success: "Set phone number",
      error: "Failed to set phone number",
    });
    await utils.user.invalidate();
  };
  const filteredData = useMemo(() => {
    if (showOldSemesters) {
      return data || [];
    }
    const currentSemesters = getValidSemesters();
    return data?.filter((section) => currentSemesters.includes(section.semester)) || [];
  }, [data, showOldSemesters]);

  const matchingSection = data?.find((s) => s.id === section);
  return (
    <div className={"flex flex-col h-full py-4 gap-4"}>
      {isLoading && <LinearProgress />}
      {isAdmin && <AdminEmailSetter />}
      {userInfo && <h1>Welcome, {userInfo.email}</h1>}
      {section && (
        <>
          {didSucceedInWatchingSection ? (
            <div className={"flex flex-col bg-green-200 rounded-lg p-1 w-fit"}>
              <div className="space-y-2 ">
                <h1 className="text-3xl font-bold">Success</h1>
                <p className="max-w-md">
                  You will continue receiving notifications for{" "}
                  {matchingSection?.ClassInfo?.courseNumber || "this class"}
                </p>
              </div>
            </div>
          ) : (
            <div className={"flex flex-col justify-center bg-red-200 rounded-lg p-1 w-fit"}>
              <div className={"text-xl"}>Error</div>
              There was an issue watching section - please reach out to usc-schedule-helper@jonlu.ca for more help:{" "}
              {section}
            </div>
          )}
        </>
      )}
      {userInfo && (
        <div className={"flex items-center gap-2"}>
          <div className={"flex items-center gap-2"}>
            Phone: <EditPhoneGlobal />
          </div>
          {userInfo.phone && (
            <button
              className="inline-flex py-1 items-center justify-center rounded-md bg-gray-900 px-3 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 disabled:pointer-events-none disabled:opacity-50"
              disabled={isPending}
              onClick={setAccountLevelPhoneToAllSections}
            >
              Use for all classes
            </button>
          )}
        </div>
      )}
      <div className={"flex"}>
        <SettingEntry
          checked={showOldSemesters}
          onChange={() => setShowOldSemesters(!showOldSemesters)}
          title="Show Old Semesters"
          subtitle="Show classes from previous semesters"
        />
      </div>

      {/* Grid goes here */}
      {!isLoading && (
        <div style={{ height: "600px", width: "100%" }}>
          <AgGridReact<Section>
            key={`${userInfo?.id}`}
            theme={themeQuartz}
            rowData={filteredData}
            columnDefs={columns}
            defaultColDef={defaultColDef}
          />
        </div>
      )}
      <div className="flex flex-col items-start gap-2 bg-gray-100 p-3 md:p-2 rounded-lg shadow-inner w-full max-w-2xl">
        {/* Beta tag with violet background */}
        <div className="flex flex-col items-start md:flex-row md:items-center gap-2 w-full">
          <Typography variant="body2" className="bg-orange-300 text-white px-2 rounded-md font-bold text-[12px]">
            {"Note"}
          </Typography>
          <Typography variant="body2" className="text-neutral-400 font-bold text-[12px] mx-auto">
            If you want to enable text notifications for a class, make sure the phone number for that section is correct
            and then click the venmo ID number, or venmo the exact 8 digits in that column to @JonLuca
          </Typography>
        </div>
      </div>
    </div>
  );
}
