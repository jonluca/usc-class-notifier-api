import { Button, Row, Section, Text } from "react-email";
import * as React from "react";
import EmailBase from "./components/EmailBase";
import { baseDomain } from "@/constants";
import type { Course, Section as ClassSection } from "@/server/api/types.ts";

export interface SpotsAvailableEmailProps {
  email: string;
  key: string;
  sectionId: string;
  sectionEntry: ClassSection;
  course: Course;
  numberOfStudentsWatching: number;
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

const neutralButtonStyle = {
  backgroundColor: "#404040",
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

const SpotsAvailableEmail = ({ course, sectionEntry, key, sectionId }: SpotsAvailableEmailProps) => {
  const spotsAvailable = sectionEntry.totalSeats - sectionEntry.registeredSeats;
  const className = course.name;
  const courseID =
    course.publishedCourseCode?.courseHyphen || course.scheduledCourseCode?.courseHyphen || course.fullCourseName;
  const section = sectionEntry.sisSectionId;
  const spotText = spotsAvailable === 1 ? "spot" : "spots";
  const previewText = `${spotsAvailable} ${spotText} available in ${courseID}`;
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
            You are receiving this email because you requested to be notified when spots opened up for {courseID},{" "}
            {className} - Section {section}.
          </Text>
        </Row>
        <Row>
          <Text
            style={{
              color: "#000000",
              fontSize: "16px",
              paddingLeft: "8px",
              paddingRight: "8px",
              margin: 0,
              fontWeight: "bold",
              marginTop: "8px",
            }}
          >
            You will not be notified again unless you click the button below.
          </Text>
        </Row>
      </Section>
      <Button style={primaryButtonStyle} href={`${baseDomain}/watch?key=${key}&section=${sectionId}`}>
        Continue receiving notifications
      </Button>
      <Button style={neutralButtonStyle} href={`${baseDomain}/dashboard?key=${key}`}>
        View Dashboard
      </Button>
      <Button style={secondaryButtonStyle} href={`${baseDomain}/faq?key=${key}`}>
        FAQ
      </Button>
    </EmailBase>
  );
};

SpotsAvailableEmail.PreviewProps = {
  email: "usc-schedule-helper@jonlu.ca",
  key: "asf",
  sectionId: "29908",
  numberOfStudentsWatching: 2,
  sectionEntry: {
    sisSectionId: "29908",
    linkCode: "A",
    linkCodeForSort: "A",
    rnrSessionId: 35662,
    peSectionId: 733723,
    courseId: 58931,
    hasDClearance: true,
    classType: null,
    name: null,
    notes: null,
    description: null,
    group: null,
    schedule: [
      {
        dayCode: "MW",
        days: ["Mon", "Wed"],
        startTime: "15:00",
        endTime: "15:50",
        location: "THH101",
        building: "THH",
        room: "101",
        sectionLocationSqNumber: 1,
        buildingRoom: "THH 101",
      },
    ],
    totalSeats: 115,
    registeredSeats: 89,
    waitlistedSeats: null,
    rnrMode: "Lecture",
    session: {
      termCode: "20261",
      rnrSessionCode: "001",
      description: null,
      rnrSessionId: 35662,
    },
    units: ["2.0"],
    instructors: [
      {
        firstName: "Mohammad Reza",
        lastName: "Rajati",
      },
    ],
    syllabus: "https://usc.simplesyllabus.com/en-US/syllabus/Spring 2026/CSCI/102/29908",
    isCancelled: false,
    isFull: false,
    rnrModeCode: "C",
    term: {
      value: 20261,
      year: 2026,
      term: 1,
      season: "Spring",
    },
    termCode: 20261,
    season: "Spring",
    year: 2026,
  },
  course: {
    courseId: 58931,
    startTermCode: 0,
    endTermCode: null,
    classNumber: "102",
    sequence: null,
    suffix: null,
    description: "Fundamental concepts of algorithmic thinking as a primer to programming. Introduction to C++.",
    fullCourseName: "CSCI 102",
    isCrossListed: false,
    maxUnits: null,
    courseNotes: null,
    termNotes: null,
    duplicateCredit: null,
    recommendedPrep: null,
    geCode: null,
    scheduledCourseCode: {
      prefix: "CSCI",
      number: "102",
      suffix: "",
      courseHyphen: "CSCI-102",
      courseSpace: "CSCI 102",
      courseSmashed: "CSCI102",
    },
    publishedCourseCode: {
      prefix: "CSCI",
      number: "102",
      suffix: "",
      courseHyphen: "CSCI-102",
      courseSpace: "CSCI 102",
      courseSmashed: "CSCI102",
    },
    matchedCourseCode: {
      prefix: "CSCI",
      number: "102",
      suffix: "",
      courseHyphen: "CSCI-102",
      courseSpace: "CSCI 102",
      courseSmashed: "CSCI102",
    },
    courseUnits: [2],
    sections: null,
    prerequisiteCourseCodes: null,
    corequisiteCourseCodes: null,
    courseRestrictions: [],
    majorRestrictions: null,
    schoolRestrictions: null,
    concurrentCourses: null,
    remainingSectionSeats: 230,
    sectionSeatCount: 230,
    termCode: 20261,
    prefix: "CSCI",
    name: "Introduction to Programming",
    sortOrder: 0,
  },
} satisfies SpotsAvailableEmailProps;

export default SpotsAvailableEmail;
