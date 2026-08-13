import { Section, Link, Text } from "react-email";
import * as React from "react";

const EmailFooter = () => {
  return (
    <Section style={{ textAlign: "center", marginTop: "12px" }}>
      <Text
        style={{
          color: "#000000",
          fontSize: "12px",
          textAlign: "center",
          fontWeight: "bold",
          padding: 0,
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        }}
      >
        Made with ❤️ by{" "}
        <Link
          style={{ textDecoration: "underline", color: "#000000" }}
          href={"https://www.instagram.com/jonlucadecaro/"}
        >
          JonLuca DeCaro
        </Link>
      </Text>
    </Section>
  );
};

export default EmailFooter;
