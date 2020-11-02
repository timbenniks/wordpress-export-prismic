const fetch = require('node-fetch')
const chalk = require('chalk')
const cheerio = require('cheerio')
const phpunserialize = require('phpunserialize')
const WP_API = `https://domainemalpaskookt.com/wp-json/wp/v2`
const recipeData = require('./recipes.json')
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const fs = require('fs')
const path = require('path')

const OUTPUT_PATH = path.join(process.cwd(), `./import`)
const HTML_PARSER = `./htmlParser.rb`;

async function getAllWp(resource, queryParams) {
  let page = 1
  const baseQuery = `${WP_API}/${resource}?per_page=100&${queryParams}`

  const totalPages = await fetch(baseQuery, { mode: 'headers' })
    .then(response => response.headers.get('x-wp-totalpages'))
  
  const getPage = async page => {
    console.log(chalk.gray(`Fetching ${page > 1 ? `page ${page} of ` : ``}${resource}...`))
  
    return await fetch(`${baseQuery}&page=${page}`).then(response => {
      if (!response.ok) {
        throw new Error(`Fetching ${resource} failed with code ${response.status}`)
      }
      return response.json()
    })
  }

  const resources = await getPage(page)

  while (page < totalPages) {
    page++
    Array.prototype.push.apply(resources, await getPage(page))
  }

  return resources
}

async function getCommentsForPost(id) {
  return await fetch(`${WP_API}/comments?post=${id}`).then(response => {
    if (response.ok) {
      return response.json()
    }
    else {
      return false
    }
  })  
}

async function getPosts() {
  const posts = await getAllWp('posts')
  return Promise.all(posts.map(async post => {
    return {
      id: post.id,
      date: post.date,
      slug: post.slug,
      title: post.title.rendered,
      content: await cleanupContent(post.content.rendered),
      excerpt: post.excerpt.rendered,
      categories: post.categories,
      tags: post.tags,
      image: post.jetpack_featured_media_url,
      comments: await getCommentsForPost(post.id),
      og: {
        title: post._yoast_wpseo_title || post.title.rendered,
        desc: post._yoast_wpseo_metadesc
      }
    }
  }))
}

async function cleanupContent(html) {
  const $ = cheerio.load(html, { decodeEntities: true })
  if($('.wprm-recipe-container')){
    $('.wprm-recipe-container').remove()
  }
  $('img').remove()

  $('strong').each((i, el) => {
    return $(el).replaceWith($(el).text());
  });

  const res = $.html('body').replace(/<body>|<\/body>/g, '').replace(/\r?\n|\r/g, '').replace(/<p><\/p>/g, '')

  return await new Promise((resolve, reject) => {
    exec(
      `ruby ${HTML_PARSER} ${res}`, (err, stdout) => {
        if(err) {
          reject(err)
        }

        resolve(JSON.parse(stdout))
      }
    );
  });
}

async function getMetadata(which) {
  const meta = await getAllWp(which)
  
  return meta.map(m => {
    return {
      id: m.id,
      name: m.name,
      slug: m.slug
    }
  })
}

function mapMetadata(ids, items) {
  return ids.map(id => {
    const item = items.find(item => item.id === id)
    return {
      id: item.id,
      name: item.name,
      slug: item.slug
    }
  })
}

function mapRecipeData(post) {
  const recipeExportData = recipeData.channel.item.find(item => item.title === post.title)

  if(!recipeExportData) {
    return false
  }

  return {
    instructions: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_instructions', false),
    ingredients: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_ingredients', true),
    servings: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings', false),
    servingsUnit: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_servings_unit', false),
    prepTime: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_prep_time', false),
    cookTime: getMetaDatafromRecipe(recipeExportData.postmeta, 'wprm_cook_time', false),
  }
}

function enrichPostsWithMetadata(options) {
  return options.posts.map(post => {
    return {
      ...post,
      tags: mapMetadata(post.tags, options.tags),
      categories: mapMetadata(post.categories, options.categories),
      recipe: mapRecipeData(post)
    }
  })
}

function getMetaDatafromRecipe(data, which, unserialize = false) {
  const result = data.find(d => d.meta_key === which)
  return unserialize ? phpunserialize(result.meta_value) : result.meta_value
}

function writePost(post) {
  return new Promise((resolve, reject) => {
    fs.writeFile(`${OUTPUT_PATH}/new_${uuidv4()}_nl-NL.json`, JSON.stringify(post, null, 2), (err) => {
      if(err) {
        reject(err);
      }
      resolve();
    });
  });
}

(async () => {
  const posts = enrichPostsWithMetadata({
    posts: await getPosts(),
    tags: await getMetadata('tags'),
    categories: await getMetadata('categories')
  })

  return Promise.all(posts.map(writePost));
})()