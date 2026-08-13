import { Button, Link, Row, Section, Text } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import { buildPaymentHelpUrl, formatSemester } from "@/utils/venmoPayment";
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
  const courseNumber = classInfo?.courseNumber;
  const semester = formatSemester(sectionEntry.semester);
  const paymentDetails = `${courseNumber ? `${courseNumber} · ` : ""}Section ${sectionEntry.section} · ${semester}`;
  const previewText = `Payment received for ${paymentDetails}`;
  const paymentHelpUrl = buildPaymentHelpUrl({
    paidId: sectionEntry.paidId,
    section: sectionEntry.section,
    semester: sectionEntry.semester,
    courseNumber,
  });

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
            Your $1.00 payment has been processed for {courseNumber ? `${courseNumber}, ` : ""}Section{" "}
            {sectionEntry.section} for {semester}.
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
        <Row>
          <Text style={{ color: "#000000", fontSize: "14px", padding: "12px 8px 0", margin: 0 }}>
            Payment note: <strong>{sectionEntry.paidId}</strong>. This payment covers this section for {semester}; you
            do not need to pay again for additional alerts for the same section.
          </Text>
        </Row>
        <Row>
          <Text style={{ color: "#000000", fontSize: "14px", padding: "8px 8px 0", margin: 0 }}>
            Something look wrong? <Link href={paymentHelpUrl}>Get payment help</Link>.
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
