import { Button, Row, Section, Text } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import type { WatchedSection, ClassInfo } from "@app/prisma";

export interface PaidProcessedEmailProps {
  verificationKey: string;
  email: string;
  sectionEntry: WatchedSection;
  classInfo: ClassInfo | null;
}

const primaryButtonStyle = {
  backgroundColor: "#000000",
  borderRadius: "12px",
  color: "#ffffff",
  fontWeight: "bold" as const,
  textDecoration: "none" as const,
  textAlign: "center" as const,
  paddingTop: "8px",
  paddingBottom: "8px",
  width: "100%",
  fontSize: "18px",
  marginTop: "16px",
  display: "block",
};

const secondaryButtonStyle = {
  backgroundColor: "#ede9fe",
  borderRadius: "12px",
  color: "#000000",
  fontWeight: "bold" as const,
  textDecoration: "none" as const,
  textAlign: "center" as const,
  paddingTop: "8px",
  paddingBottom: "8px",
  width: "100%",
  fontSize: "18px",
  marginTop: "8px",
  display: "block",
};

const PaidProcessedEmail = ({ classInfo, sectionEntry, verificationKey }: PaidProcessedEmailProps) => {
  const headerTitle = classInfo?.courseNumber || `Section ${sectionEntry.section}`;
  const previewText = `Payment received for ${headerTitle}!`;

  return (
    <EmailBase previewText={previewText}>
      <Text
        style={{
          color: "#000000",
          fontSize: "24px",
          fontWeight: "bold",
          textAlign: "center",
          padding: 0,
          marginTop: "24px",
          marginLeft: 0,
          marginRight: 0,
        }}
      >
        {previewText}
      </Text>
      <Section style={{ marginLeft: "auto", marginRight: "auto", marginTop: "24px" }}>
        <Row>
          <Text style={{ color: "#000000", fontSize: "16px", paddingLeft: "8px", paddingRight: "8px", margin: 0 }}>
            Your payment has been processed for {headerTitle ? `${headerTitle} - ` : ""}Section {sectionEntry.section}.
          </Text>
        </Row>
        <Row>
          <Text
            style={{
              color: "#000000",
              fontSize: "16px",
              paddingLeft: "8px",
              paddingRight: "8px",
              paddingTop: "16px",
              margin: 0,
            }}
          >
            You will now receive text notifications when spots open up for this section.
          </Text>
        </Row>
      </Section>
      <Button style={primaryButtonStyle} href={`${baseDomain}/dashboard?key=${verificationKey}`}>
        View Dashboard
      </Button>
      <Button style={secondaryButtonStyle} href={`${baseDomain}/faq?key=${verificationKey}`}>
        FAQ
      </Button>
    </EmailBase>
  );
};

// @ts-ignore
PaidProcessedEmail.PreviewProps = {
  sectionEntry: {
    id: "123",
    section: "12345",
    semester: "20243",
    notified: false,
    paidId: "12345678",
    isPaid: true,
    paidNotified: false,
  },
  email: "usc-schedule-helper@jonlu.ca",
  classInfo: {
    courseNumber: "CSCI 104",
    department: "CSCI",
    id: "123",
    name: "Data Structures",
  },
  verificationKey: "asdf",
} as PaidProcessedEmailProps;

export default PaidProcessedEmail;
