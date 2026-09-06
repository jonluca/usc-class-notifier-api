import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const schoolId = "U2Nob29sLTEzODE=";

interface RMPResponse {
  data: {
    search: {
      teachers: {
        edges: { node: Professor }[];
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    };
  };
}

export interface Professor {
  avgRating: number;
  firstName: string;
  lastName: string;
  legacyId: number;
}

export function mergeProfessorRatings(existing: Professor[], refreshed: Professor[]): Professor[] {
  const professors = new Map<number, Professor>();
  for (const { avgRating, firstName, lastName, legacyId } of [...existing, ...refreshed]) {
    professors.set(legacyId, { avgRating, firstName, lastName, legacyId });
  }
  return [...professors.values()].sort((a, b) => a.legacyId - b.legacyId);
}

const loadByCursor = async (cursor?: string | null) => {
  const baseVariables = {
    query: {
      schoolID: schoolId,
    },
    count: 1000,
  };
  const variables = cursor ? { ...baseVariables, cursor } : baseVariables;
  const response = await axios.post<RMPResponse>(
    "https://www.ratemyprofessors.com/graphql",
    {
      query: `query TeacherSearchResultsPageQuery(
  $query: TeacherSearchQuery!
  $count: Int!
  ${cursor ? "$cursor: String" : ""}
) {
  search: newSearch {
    teachers(query: $query, first: $count, after: ${cursor ? "$cursor" : '""'}) {
      edges {
        node {
          legacyId
          avgRating
          firstName
          lastName
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`,
      variables,
    },
    {
      headers: {
        Accept: "*/*",
        "Accept-Language": "en",
        Authorization: "Basic dGVzdDp0ZXN0",
        Connection: "keep-alive",
        "Content-Type": "application/json",
        Cookie: "ccpa-notice-viewed-02=true",
        Origin: "https://www.ratemyprofessors.com",
        Referer: "https://www.ratemyprofessors.com/search.jsp",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
      },
    },
  );
  return response.data;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const run = async () => {
  let cursor: string | null = null;
  let professors: Professor[] = [];
  while (true) {
    const data = await loadByCursor(cursor);
    const { teachers } = data.data.search;
    professors = professors.concat(teachers.edges.map((l) => l.node));
    if (!teachers.pageInfo.hasNextPage) {
      break;
    }
    cursor = teachers.pageInfo.endCursor;
    console.log(`Fetched ${professors.length} professors`);
  }

  const ratingsFile = path.join(__dirname, "../src/data/ratings.json");
  const existing = await fs.readFile(ratingsFile, "utf-8");
  const existingProfessors: Professor[] = JSON.parse(existing);
  professors = mergeProfessorRatings(existingProfessors, professors);
  await fs.writeFile(ratingsFile, JSON.stringify(professors, null, 4));
};
if (import.meta.main) {
  await run();
}
