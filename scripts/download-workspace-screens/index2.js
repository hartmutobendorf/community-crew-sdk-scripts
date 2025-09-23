import { ZeplinApi, Configuration } from '@zeplin/sdk';
import Progress from 'progress';
import axios from 'axios';
import fs from 'fs/promises';
import { config } from 'dotenv';
import rateLimit from 'axios-rate-limit';
import pLimit from 'p-limit';

// Set your dotenv config to the root directory where the .env file lives
config({ path: '../../.env' });

// Extract PAT and Workspace from .env
const { PERSONAL_ACCESS_TOKEN, WORKSPACE_ID } = process.env;

// Directory name for saved screens
const dir = 'Output2';

// Zeplin API rate limit is 200 requests per user per minute.
// Use rateLimit to extend Axios to only make 200 requests per minute (60,000ms)
const http = rateLimit(axios.create(), { maxRequests: 200, perMilliseconds: 60000 });

// Instantiate ZeplinClient with access token
const zeplin = new ZeplinApi(
  new Configuration(
    { accessToken: PERSONAL_ACCESS_TOKEN },
  ),
  undefined,
  http,
);

// First get all projects in your workspace
// Save a new fragment with the "Save selection as Code Fragment" command.
const getAllProjects = async () => {
  const projects = [];
  let data;
  let i = 0;
  do {
    // Must access this endpoint with await
    // eslint-disable-next-line no-await-in-loop
    ({ data } = await zeplin.organizations.getOrganizationProjects(WORKSPACE_ID, {
      offset: i * 100,
      limit: 20,
    }));
    projects.push(...data);
    i += 1;
  } while (data.length === 100);
  return projects.filter((project) => project.status === 'active');
};

// Get screen data. Screens do not include project names in their response,
// so add the data for referencing the save directory later
const getProjectScreens = async (project) => {
  const { name: projectName, numberOfScreens } = project;

  const iterations = [...Array(Math.ceil(numberOfScreens / 100)).keys()];
  const screens = (await Promise.all(iterations.map(async (i) => {
    const { data } = await zeplin.screens.getProjectScreens(
      project.id,
      { offset: i * 100, limit: 100 },
    );
    return data;
  }))).flat();

  return screens.map((screen) => ({
    projectName,
    ...screen,
  }));
};

const nicefyPath = (path) => path.trim().replaceAll(" ", "_").replaceAll("/", "-");

const downloadScreen = async (project, screen, progress) => {
  const { name, image: { originalUrl }, numberOfVersions, projectName } = screen;

  if (numberOfVersions > 1 && screen.id) {
    try {
      const limit = pLimit(20);
      const screenVersions = (await zeplin.screens.getScreenVersions(project.id, screen.id, {limit: 100, offset: 0})).data;
      screenVersions.map(async (screenVersion) => limit(async () => {
        const { imageUrl, created } = screenVersion;
        const { data } = await axios.get(imageUrl, { responseType: 'stream' });

        await fs.mkdir(`${dir}/${nicefyPath(projectName)}`, { recursive: true });
        await fs.writeFile(`${dir}/${nicefyPath(projectName)}/${nicefyPath(name)}_${created}.png`, data);
      }));
    } catch (e) {
      if (e?.response?.data)
        console.log(e.response.data);
      else
        console.log(e);
    }
  } 

  const { data } = await axios.get(originalUrl, { responseType: 'stream' });

  await fs.mkdir(`${dir}/${nicefyPath(projectName)}`, { recursive: true });
  await fs.writeFile(`${dir}/${nicefyPath(projectName)}/${nicefyPath(name)}.png`, data);

  progress.tick();
};

const main = async () => {
  const projects = await getAllProjects();

  console.log(`There are ${projects.length} projects`);

  const projectScreens = (await Promise.all(projects.map(
    async (project) => { return { project: project, screens: await getProjectScreens(project) }; }
  )));

  const screens = projectScreens.map( ps => ps.screens ).flat();
  console.log(`There are ${screens.length} screens`);

  const screensBar = new Progress('  Fetching screens [:bar] :rate/bps :percent :etas', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: screens.length,
  });

  // Remove existing Output folder and create new one at start of script
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir);

  const limit = pLimit(20);
  const downloadScreens = projectScreens.map((pscreen) => pscreen.screens.map((screen) => limit(() => downloadScreen(pscreen.project, screen, screensBar))));

  await Promise.all(downloadScreens);
};

await main();
