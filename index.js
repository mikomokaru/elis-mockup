const express = require('express')
const app = express()
const swaggerJSDoc = require('swagger-jsdoc')
const swaggerUi = require('swagger-ui-express')
const Airtable = require('airtable')
const bodyParser = require('body-parser')
const _ = require('lodash')
Airtable.configure(require('airtable-auth'))
const base = Airtable.base('appb6z3h3fuTcygMi')

app.use((req,res,next)=> {
    res.header({
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Headers": "Origin,X-Requested-With, Content-Type, Accept"
    })
    return next();
})
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({limit: '10mb'}))
const swaggerSpec = swaggerJSDoc({
    swaggerDefinition: {
        info: {
            title: 'elis-api-mockup',
            description: `
ELISをRESTAPI化したサンプルモックアップです。
サンプルですので、店舗やアイテムを絞り、簡易的な[DB](https://airtable.com/)をバックエンドにして作成されています。
本APIの利用に認証は不要です。
***
利用マスタ及びトランザクションデータは以下を参照ください。
各データはAPIを介してのみ変更可能です。マスタ等の変更は当社までご依頼ください。
## [店舗](https://airtable.com/shrU8VLSUcQZNacQB/tbl3hmDcRkfVDJUpD)
店舗マスタです。
## [アイテム](https://airtable.com/shrUue4Hju9O4XkWv)
商品マスタです。
## [カレンダー](https://airtable.com/shr4RCUYnvN01g1oI)
どの店舗でいつどの商品の窓を開けるかを定義するマスタです。
## [注文](https://airtable.com/shr4RCUYnvN01g1oI)
注文が溜まっていくトランザクションテーブルです。
***
用意したAPIは3つ。
1. 店舗・日付範囲を指定して、現在の注文状況を出力する
2. 店舗・商品・個数を指定して発注を行う。
3. 店舗・日付範囲を指定して発注カレンダーを出力する
詳細は以下をご参照ください。
            `,
            produces: ["application/json"],
            version: '1.0.0.'
        },
    },
    apis: ['./index.js']
})

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

//IDの配列を返す（UPDATE用）
const getIdArray = (airResult)=>
    _.chain(airResult)
    .map((v)=> v.id)
    .take(1)
    .value()


/**
 * @swagger
 * /:orgCode/orders:
 *   get:
 *     description: |
 *       ## 注文状況の出力
 *       店舗->倉庫に対して行った発注のリストを表示します。
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: orgCode
 *         description: 対象の店舗コード
 *         in: path
 *         required: true
 *         type: string
 *       - name: dayFrom
 *         description: 対象とする期間開始日
 *         in: query
 *         required: true
 *         type: string
 *       - name: dayTo
 *         description: 対象とする期間終了日
 *         in: query
 *         required: true
 *         type: string
 *     responses:
 *       200:
 *         description: 指定期間の発注リスト
  *         schema:
 *           type: array
 *           items:
 *               type: object
 *               properties:
  *                 targetDate:
 *                   type: "String"
 *                   example: "2020-12-01"
 *                 itemCode:
 *                   type: "Integer"
 *                   example: 1
 *                 itemName:
 *                    type: "String"
 *                    example: "醤油タレ"
 *                 pcs:
 *                    type: "Integer"
 *                    example: 5
 */
app.get('/:orgCode/orders', async (req, res)=> {
    const params = _.extend(req.params,req.query)
    const ret = _.chain(await base('カレンダー').select(
        {filterByFormula: `AND(
            FIND('${params.orgCode}',ARRAYJOIN({注文可能店舗})) > 0,
            AND(IS_AFTER({発注可能日},DATEADD('${params.dayFrom}',-1,'day'))),
            AND(IS_BEFORE({発注可能日},DATEADD('${params.dayTo}',1,'day')))
        )`}
    ).firstPage())
    .map((v)=> _.get(v,'fields'))
    .map((v)=> 
        _.chain(v['注文可能アイテムリスト'])
        .map(JSON.parse)
        .map((w)=> _.extend(w,{
            orgCode: v['店舗コード'],
            orderDate: v['発注可能日'],
        }))
        //注文が入っていたら個数を入れる
        .map((w)=>
            _.extend(w,{
                pcs: _.chain(v['注文アイテムリスト'])
                .map(JSON.parse)
                .filter((x)=> w.itemCode === x.itemCode && w.orderDate === x.orderDate)
                .map((x)=> x.pcs)
                .head()
                .value() || 0,
                orderNo: _.chain(v['注文アイテムリスト'])
                .map(JSON.parse)
                .filter((x)=> w.itemCode === x.itemCode && w.orderDate === x.orderDate)
                .map((x)=> x.orderNo)
                .head()
                .value() || null
            })            
        )
        .value()
    )
    .flatten()
    .sortBy(['orderDate','itemCode'])
    res.json(ret.value())
})

/**
 * @swagger
 * /:orgCode/orders:
 *   post:
 *     description: |
 *       ## 発注処理
 *       店舗->倉庫に対して発注を行います。
 *       商品コード・発注日・発注個数を含むオブジェクトをPOSTすることで
 *       発注を行うものとします。複数の注文を同時に行う場合は、このリソースに対して
 *       連続POSTを行うものとします。
 *       発注不可の組み合わせの場合は403:forbiddenを返します。
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: orgCode
 *         description: 対象の店舗コード
 *         in: path
 *         required: true
 *         type: string
 *       - name: "body"
 *         in: "body"
 *         required: true
 *         schema:
 *          type: "object"
 *          properties:
 *              itemCode:
 *                  type: "string"
 *                  example: "1"
 *              orderDate:
 *                  type: "string"
 *                  example: "2020-12-01"
 *              pcs:
 *                  type: "int"
 *                  example: 12
 *     responses:
 *       200:
 *         description: 発注が成功したときのレスポンス
 *       403:
 *         description: 発注禁止の組み合わせで発注したときのレスポンス
 */
app.post('/:orgCode/orders', async (req, res)=> {
    const params = _.extend(req.body,req.params)
    const o = getIdArray(
        await base("店舗").select({
            fields: ["店舗コード","店舗名"],
            filterByFormula: `{店舗コード} = ${params.orgCode}`
        }).firstPage()
    )
    const d = getIdArray(
        await base("カレンダー").select({
            fields: ["発注可能日"],
            filterByFormula: `{発注可能日} = DATETIME_PARSE('${params.orderDate}')`
        }).firstPage()
    )
    const i = getIdArray(
        await base("アイテム").select({
            fields: ["商品コード"],
            filterByFormula: `{商品コード} = ${params.itemCode}`
        }).firstPage()
    )
    ret = await base("注文").create([
        {
            fields:{
                "店舗": o,
                "注文日": d,
                "アイテム":i,
                "個数": params.pcs
            }    
        }
    ])

    return _.chain(ret)
    .map((v)=> _.get(v,'fields.注文コード'))
    .map(JSON.parse)
    .map((v)=> res.json(v))
    .value()
})

/**
 * @swagger
 * /:orgCode/items:
 *   get:
 *     description: |
 *       ## 指定期間内のカレンダーを表示します。
 *       店舗で注文できるすべての商品 x 指定期間に含まれる日付のデータに対して、
 *       以下の情報を付与したものを配列として返却します。
 *       - 窓が開いている場合は```open```属性を```true```とする
 *       - 注文が入っている場合は```pcs```属性に非0をセット
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: orgCode
 *         description: 対象の店舗コード
 *         in: path
 *         required: true
 *         type: string
 *       - name: dayFrom
 *         description: 対象とする期間開始日
 *         in: query
 *         required: true
 *         type: string
  *       - name: dayTo
 *         description: 対象とする期間終了日
 *         in: query
 *         required: true
 *         type: string
 *     responses:
 *       200:
 *         description: 成功したときのレスポンス
 *         schema:
 *           type: array
 *           items:
 *               type: object
 *               properties:
  *                 targetDate:
 *                   type: "String"
 *                   example: "2020-12-01"
 *                 itemCode:
 *                   type: "Integer"
 *                   example: 1
 *                 itemName:
 *                    type: "String"
 *                    example: "醤油タレ"
 *                 open:
 *                    type: "Boolean"
 *                    example: true
 *                 pcs:
 *                    type: "Integer"
 *                    example: 5
 */
app.get('/:orgCode/items',async (req, res)=> {
    const params = _.extend(req.params,req.query)
    const ret = await base("カレンダー").select({
        fields: ["発注可能日","注文可能アイテムリスト","注文アイテムリスト"],
        sort: [{field: "発注可能日", direction: "asc"}],
        filterByFormula: `
            and(
                {発注可能日} >= DATETIME_PARSE('${params.dayFrom}'),
                {発注可能日} <= DATETIME_PARSE('${params.dayTo}'),
                FIND("${params.orgCode}",ARRAYJOIN({注文可能店舗}))
            )`
    }).firstPage()

    const obase = _.chain(ret)
    .map((v)=> _.get(v, "fields"))
    .map((v)=> ({
        targetDate: _.get(v,"発注可能日"),
        orders: _.map(_.get(v,"注文アイテムリスト"),JSON.parse) || [],
        availableItems: _.map(_.get(v, "注文可能アイテムリスト"),JSON.parse) || []
    }))
    .map((v)=> 
        _.extend(v,{
            orders: _.map(v.orders,(w)=> _.extend(w,{targetDate:v.targetDate})),
            availableItems: _.map(v.availableItems,(w)=> _.extend(w,{targetDate:v.targetDate}))
        })
    )

    const orders = _.chain(obase)
    .map((v)=> v.orders)
    .flatten()
    .filter((v)=> v.orgCode.toString() === params.orgCode.toString())
    .keyBy("itemCode")
    .value()

    const availableItems = _.chain(obase)
    .map((v)=> v.availableItems)
    .flatten()
    .keyBy("itemCode")
    .value()

    const items = _.chain(
        await base("アイテム").select({
            fields: ["商品"],
            sort: [{field: "商品コード", direction: "asc"}]
        }).firstPage()
    )
    .map((v)=> _.get(v, "fields.商品"))
    .map(JSON.parse)
    .map((v)=>
        _.extend(
            v,
            {open: !!availableItems[v.itemCode.toString()]}
        )
    )
    .map((v)=>
        _.extend(
            v,
            {pcs: (orders[v.itemCode.toString()] || {pcs:0}) .pcs}
        )
    )
    .value()
    res.json(items)
})

app.listen(3000, ()=> console.log("Listen on port 3000."))