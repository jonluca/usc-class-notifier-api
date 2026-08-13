import Dashboard from "@/components/Dashboard";
import React from "react";
import type { GetServerSideProps } from "next";
import { loadWatchPageProps } from "@/server/watchPage";

export default ({ didSucceed, section }: { section: string; didSucceed: boolean }) => {
  return <Dashboard section={section} didSucceedInWatchingSection={didSucceed} />;
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  return {
    props: await loadWatchPageProps(context),
  };
};
