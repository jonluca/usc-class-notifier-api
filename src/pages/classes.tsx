import Link from "next/link";
import { SectionSearch } from "@/components/SectionSearch";

export default function Classes() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 py-8 sm:py-12">
      <h1 className="text-3xl font-bold">Find your USC classes</h1>
      <SectionSearch />
      <p className="text-sm">
        <Link className="font-semibold underline" href="/dashboard">
          Manage your alerts in the dashboard
        </Link>
      </p>
    </div>
  );
}
