// Product taxonomy: classify actual major operating businesses; company tags are multi-select.
export const INDUSTRY_TAXONOMY=Object.freeze({
  "version": "2026-09-28-multi-v1",
  "assignment": "multiple_major_businesses",
  "industries": [
    {
      "id": "software_it",
      "label": "软件、云与 IT 服务",
      "aliases": [
        "软件",
        "软件服务",
        "IT服务",
        "云计算"
      ],
      "description": "以软件许可、SaaS、云平台、独立AI模型/API、IT实施运维和软件外包为核心交付。网络安全、数据服务等独立软件与IT交付纳入；软件内消息功能不等于电信连接经营。",
      "exclude": "自用软件、设备固件、附属工具；银行和医院等客户行业不改变软件公司的行业。"
    },
    {
      "id": "internet_platforms",
      "label": "互联网平台与信息服务",
      "aliases": [
        "社交平台",
        "搜索平台",
        "在线信息服务"
      ],
      "description": "以搜索、社交、通用内容社区、在线信息或通用撮合平台为核心交付。用户创作内容社区属于平台；以版权内容制作发行和播映为核心的流媒体归传媒。",
      "exclude": "游戏归游戏；商品交易平台归商贸；旅游预订归旅游；内容制作出版归传媒；有网站或线上渠道不构成本行业。"
    },
    {
      "id": "games",
      "label": "游戏",
      "aliases": [
        "游戏行业"
      ],
      "description": "游戏研发、发行、运营，以及直接制作游戏内容的专门开发业务。",
      "exclude": "通用开发工具和基础云服务归软件；仅有游戏客户不成立；具体研发、发行、运营、美术外包在业务标签区分。"
    },
    {
      "id": "semiconductors",
      "label": "半导体",
      "aliases": [
        "芯片行业",
        "集成电路行业"
      ],
      "description": "芯片设计、晶圆制造、封装测试及明确用于半导体工艺的专用设备和专用材料。",
      "exclude": "通用设备或化学品仅拥有芯片客户不成立；普通电子元件、面板和整机另归相应产品行业。"
    },
    {
      "id": "electronic_components",
      "label": "电子元器件与组件",
      "aliases": [
        "电子元器件",
        "电子组件"
      ],
      "description": "被动元件、连接器、PCB、显示面板、电子光学器件、通用电子模组及电子组件加工。",
      "exclude": "芯片优先半导体；计算通信整机、消费电子成品和车辆专用控制系统分别归相应产品行业。"
    },
    {
      "id": "computing_network_equipment",
      "label": "计算机与网络通信设备",
      "aliases": [
        "计算机设备",
        "网络设备",
        "通信设备行业"
      ],
      "description": "计算机、服务器、存储、网络通信设备、光纤光缆及专用通信基础设施产品。桌面、笔记本和平板计算机统一纳入本类。",
      "exclude": "手机、穿戴和其他个人消费电子归消费电子与家电；提供网络连接的运营商归通信服务；芯片和一般元件另归。"
    },
    {
      "id": "consumer_electronics_appliances",
      "label": "消费电子与家用电器",
      "aliases": [
        "消费电子行业",
        "家电行业"
      ],
      "description": "手机、穿戴、视听摄影、智能家居、家用及商用家电、照明成品和家用清洁机器人等终端产品。",
      "exclude": "工业机器人、工程设备、电子组件和家具另归；使用智能技术不额外生成行业。无人机整机归航空航天；笔记本和平板归计算机；普通相机归本类。"
    },
    {
      "id": "industrial_equipment",
      "label": "机械、机器人与仪器设备",
      "aliases": [
        "机械装备行业",
        "工业设备",
        "工业自动化行业"
      ],
      "description": "通用及专用机械、工程农矿机械、工业自动化、非家用非医疗机器人、通用测量和科研仪器。专用电池产线与工业过程控制、电机控制和工厂自动化纳入本类。",
      "exclude": "半导体专用工艺设备、发输配电装备及医疗器械优先其专类；专用生产线通常仍归机械（半导体明确例外）；不能仅凭制造、智能制造或工厂字样归入。"
    },
    {
      "id": "vehicles",
      "label": "汽车与两轮车辆",
      "aliases": [
        "汽车整车行业",
        "道路车辆",
        "两轮车辆"
      ],
      "description": "乘用车、商用车、专用汽车、摩托及电动两轮整车的研发生产、品牌经营或整车代工。",
      "exclude": "挖掘装卸等工程机械归机械设备；普通自行车归运动消费品；汽车经销商归商贸；零部件另归。"
    },
    {
      "id": "auto_components",
      "label": "汽车零部件与车载系统",
      "aliases": [
        "汽车零部件行业",
        "车载系统"
      ],
      "description": "汽车专用动力、底盘、车身、制动、车载电子和软硬件一体智驾系统等产品。",
      "exclude": "通用车规芯片归半导体；电芯电池归电气能源装备；纯软件许可归软件；车企客户不足以构成汽车业务。"
    },
    {
      "id": "aerospace_defense",
      "label": "航空航天与国防装备",
      "aliases": [
        "航空航天行业",
        "国防装备"
      ],
      "description": "飞机、无人机、火箭、卫星、专用航空航天系统以及明确国防专用装备的研发制造。包括专门航空航天维保；无人机整机统一纳入。",
      "exclude": "船舶（含军用）和轨道装备统一另归；航司机场运营归运输；通用芯片软件仅用于军工不成立。"
    },
    {
      "id": "ship_rail_equipment",
      "label": "船舶与轨道交通装备",
      "aliases": [
        "船舶装备",
        "轨道装备行业"
      ],
      "description": "船舶、轨道车辆及其专用系统部件的研发制造和专门装备维保。",
      "exclude": "航运、铁路、地铁运营归运输；港口轨道工程建设归工程；通用机械不因客户用途归此。"
    },
    {
      "id": "electrical_energy_equipment",
      "label": "电气、电池与新能源装备",
      "aliases": [
        "电气装备",
        "电池行业",
        "新能源装备"
      ],
      "description": "发输配电、电力电子、电芯电池、储能系统、风光核能装备和充换电设施等产品。光伏电池、硅片与组件归本类，集成电路晶圆归半导体；重点是电能转换、供配和存储产品。",
      "exclude": "发电及电网运营归能源供应；电池化学材料归化工；矿物原料归矿冶；建设电厂归工程。"
    },
    {
      "id": "energy_supply",
      "label": "能源开发与电力供应",
      "aliases": [
        "能源供应",
        "电力供应",
        "能源开发"
      ],
      "description": "煤炭油气能源资源开采、燃料炼制供给、发电、热力、电网运营及售电。包含直接油气田勘探、钻完井及生产技术服务；不含只制造油田设备的企业。",
      "exclude": "化学材料、发电设备制造、能源工程施工和纯燃料贸易分别归相应行业。"
    },
    {
      "id": "environment_water",
      "label": "环境治理、水务与资源回收",
      "aliases": [
        "环境治理",
        "水务行业",
        "资源回收行业"
      ],
      "description": "供排水、污废处理、污染修复、环境治理、固废危废及再生资源回收处理的实际治理与运营服务。",
      "exclude": "只生产环保设备归设备、治理药剂归化工、施工归工程；企业自用环保设施和环保承诺不成立。"
    },
    {
      "id": "chemicals_materials",
      "label": "化工与化学材料",
      "aliases": [
        "化工行业",
        "化学材料"
      ],
      "description": "基础化学品、聚合物、涂料、合成纤维、农药化肥、功能化学材料及电池化学材料。",
      "exclude": "专用半导体材料优先半导体；燃料炼制归能源；成品药、美妆日化、食品分别归其成品行业。"
    },
    {
      "id": "mining_basic_materials",
      "label": "矿冶与基础材料",
      "aliases": [
        "矿冶",
        "基础材料",
        "金属矿业"
      ],
      "description": "非能源矿产、金属冶炼加工、玻璃水泥陶瓷及基础木材纸浆原纸等材料产品。",
      "exclude": "煤炭油气归能源；成型家具、生活用纸和包装制品归消费品；建筑施工归工程。"
    },
    {
      "id": "consumer_goods",
      "label": "消费品与轻工制品",
      "aliases": [
        "日用消费品",
        "服饰家居"
      ],
      "description": "服饰鞋包、家具家纺、美妆日化、玩具文具、运动宠物用品、生活用纸及轻工包装制品的品牌或产品经营。包括工业用途的纸塑金属包装成品；基础包装原材料另归材料。",
      "exclude": "食品饮料、电子家电另有专类；销售多品牌商品的渠道企业归商贸；品牌自营门店不改变产品行业。"
    },
    {
      "id": "food_beverage",
      "label": "食品与饮料",
      "aliases": [
        "食品行业",
        "饮料行业"
      ],
      "description": "食品饮料加工制造及自有食品饮料品牌经营。宠物食品成品也归本类，畜牧饲料归农业。",
      "exclude": "初级种植养殖归农业；餐厅咖啡店归餐饮旅游；超市食品分销归商贸；动物饲料归农业。"
    },
    {
      "id": "agriculture_farming",
      "label": "农林牧渔与农业投入",
      "aliases": [
        "农业",
        "农林牧渔",
        "农牧",
        "养殖"
      ],
      "description": "种植、育种、养殖、林渔牧业、种子饲料及直接农业生产服务。",
      "exclude": "农机归设备、农药化肥归化工、食品工业加工归食品、农产品买卖归商贸。"
    },
    {
      "id": "pharma_biotech",
      "label": "医药与生物技术",
      "aliases": [
        "制药行业",
        "生物医药行业"
      ],
      "description": "药品、疫苗、原料药研发生产，以及包含实际制造的医药CDMO和配套工艺研发；主营生命科学研究用生物试剂和功能蛋白的产品企业也纳入。",
      "exclude": "医疗器械和诊断试剂归器械；医院归医疗服务；仅承接非生产药物研究、临床试验等CRO归科研检测；药品分销归商贸。"
    },
    {
      "id": "medical_devices",
      "label": "医疗器械与诊断产品",
      "aliases": [
        "医疗器械行业",
        "诊断产品"
      ],
      "description": "诊断治疗监护康复器械、医疗耗材、诊断试剂及医疗专用机器人等产品经营。",
      "exclude": "临床检验诊疗服务归医疗；纯药械批发归商贸；医院IT、通用科研仪器分别归软件或设备。"
    },
    {
      "id": "medical_services",
      "label": "医疗与健康服务",
      "aliases": [
        "医疗服务",
        "诊疗服务"
      ],
      "description": "医院诊所、临床检测体检、康复护理及直接面向患者的健康管理。",
      "exclude": "仅销售保健品药械、员工健康福利、医疗数据营销与保险不属于诊疗服务。"
    },
    {
      "id": "construction_engineering",
      "label": "工程建设与工程设计",
      "aliases": [
        "工程建设行业",
        "工程设计行业",
        "建筑工程"
      ],
      "description": "建筑土木市政水利能源等工程的规划勘察设计、施工总包、工程监理及项目管理。",
      "exclude": "工程用途不改变行业；房地产开发运营、建材生产、工程软件各归相应专类。"
    },
    {
      "id": "real_estate_property",
      "label": "房地产与物业运营",
      "aliases": [
        "房地产行业",
        "物业行业",
        "不动产运营"
      ],
      "description": "地产开发、房产经纪、房屋商业园区资产租赁运营、物业及设施管理。",
      "exclude": "工程承包设计另归；主营发行管理房地产基金归金融；持有自用楼宇不成立。"
    },
    {
      "id": "transport_logistics",
      "label": "交通运输与物流",
      "aliases": [
        "运输行业",
        "物流行业",
        "客货运输"
      ],
      "description": "客货运输、公交地铁、航司航运、快递仓储港口、货运代理与以物流为核心的供应链服务。",
      "exclude": "运输装备制造、线路工程、物流软件及货物购销各归其实际供给；保险报关代办是附属服务。"
    },
    {
      "id": "commerce_trade",
      "label": "批发零售、电商与贸易",
      "aliases": [
        "商贸",
        "零售行业",
        "贸易行业",
        "电商行业"
      ],
      "description": "批发分销、商超连锁、经销代理、进出口、大宗贸易、采购分销和商品交易平台。",
      "exclude": "产品或品牌制造商销售出口自家产品不额外增加商贸；以多品采购、零售交易履约或市场撮合为核心的零售平台即使有私牌仍归本类；货代归物流；电商软件归软件。"
    },
    {
      "id": "hospitality_tourism",
      "label": "旅游、住宿、餐饮与休闲",
      "aliases": [
        "旅游行业",
        "酒店行业",
        "餐饮行业",
        "休闲服务"
      ],
      "description": "旅行预订、旅行社景区、酒店餐饮、体育娱乐场馆及休闲服务经营。体育博彩、彩票等休闲经营归本类；慈善捐赠不构成另一个行业。",
      "exclude": "航空承运归运输；食品制造、文旅工程、旅游软件、体育用品各归实际产品；慈善捐赠不增加公益行业。"
    },
    {
      "id": "finance",
      "label": "金融与保险",
      "aliases": [
        "金融",
        "银行",
        "证券",
        "基金",
        "保险"
      ],
      "description": "银行、保险、证券、基金信托资管、信贷支付等明确对外金融产品与服务。包含融资租赁、征信及金融交易基础设施。",
      "exclude": "金融软件、集团自有持股、工程项目融资和商品销售中的代办保险不构成金融行业。"
    },
    {
      "id": "business_services",
      "label": "咨询与商务专业服务",
      "aliases": [
        "咨询",
        "专业服务",
        "商务服务行业"
      ],
      "description": "法律会计审计税务、管理咨询、人力招聘、市场研究、专家网络、翻译及商务外包等专业交付。包括工商业设备的经营性租赁；融资租赁归金融；不因出租设备而归设备制造。",
      "exclude": "工程、软件、科研检测、广告等有专门行业时优先专类；产品售后支持不成为咨询经营板块。"
    },
    {
      "id": "research_testing",
      "label": "科研、检测与技术服务",
      "aliases": [
        "科研行业",
        "检测认证行业",
        "研究机构"
      ],
      "description": "科研院所、独立研究实验、非生产合同研发、计量检测认证和以科研技术服务为核心交付的机构。",
      "exclude": "企业研发自身产品、自产产品试验认证不成立；药品合同制造归医药；临床医疗检测归医疗服务。"
    },
    {
      "id": "education",
      "label": "教育与培训",
      "aliases": [
        "教育",
        "培训",
        "学校"
      ],
      "description": "学校、职业及其他独立对外教学培训、以教学为核心交付的在线教育。",
      "exclude": "教学软件或设备、教材出版、员工培训及产品上手售后培训各按实际供给，不归教育经营板块。"
    },
    {
      "id": "media_advertising",
      "label": "文化传媒与广告营销",
      "aliases": [
        "传媒行业",
        "文化内容",
        "广告行业"
      ],
      "description": "新闻出版、影视音乐演艺、内容制作传播、IP内容经营及广告策划媒介营销服务。",
      "exclude": "游戏独立；通用社交归互联网；自有品牌宣传及广告公司内部AI工具不改变行业。"
    },
    {
      "id": "telecom_services",
      "label": "通信网络服务",
      "aliases": [
        "电信服务",
        "通信运营商",
        "网络连接服务"
      ],
      "description": "固移通信、宽带接入、卫星通信、基础及增值电信和以连接消息传送为核心的通信服务。",
      "exclude": "网络设备和芯片分别归产品行业；纯软件工具归软件；运营商客户不自动使供应商成为通信企业。"
    },
    {
      "id": "personal_services",
      "label": "居民与生活服务",
      "aliases": [
        "生活服务行业",
        "居民服务"
      ],
      "description": "家政洗护、非医疗美容、日常维修及其他直接居民生活服务。",
      "exclude": "物业、住宿餐饮、医疗、教育等已有专门行业时优先专类；生活用品制造归产品行业。"
    },
    {
      "id": "public_social",
      "label": "公共管理与社会服务",
      "aliases": [
        "公共管理",
        "公益服务",
        "国际组织"
      ],
      "description": "公共行政、国际发展、人道援助、公益救济及以公共社会使命为核心职能的机构。",
      "exclude": "事业单位的学校医院科研机构按实际职能；公司CSR捐赠和政府客户不改变公司行业。"
    }
  ],
  "rules": [
    "多选：每个行业必须对应本主体明确、实际经营的主要业务板块。",
    "逐板块按对外产品或服务选择行业；不按客户所属行业、销售渠道、内部能力、附属服务或宽泛经营范围扩张。",
    "跨行业有独立业务事实才多选；一个产品链条的研发、生产、销售不重复跨类。",
    "先判断主体和描述是否一致；缺乏依据的行业不猜测，行业数组可为空并记录待判定原因。",
    "集团按明确覆盖的实际经营板块标注；不设综合集团或投资运营兜底；持股不等于金融业务。",
    "细分产品、经营环节和其他已明确业务放具体业务标签；旧标签和公司知名度不作为依据。"
  ]
});
export const INDUSTRY_TAXONOMY_VERSION=INDUSTRY_TAXONOMY.version;
export const INDUSTRIES=INDUSTRY_TAXONOMY.industries;
export const LEGACY_INDUSTRIES=Object.freeze([
  {
    "id": "internet",
    "label": "互联网／数字科技",
    "aliases": [
      "互联网",
      "数字科技",
      "互联网/数字科技"
    ],
    "choices": [
      "software_it",
      "internet_platforms",
      "games"
    ]
  },
  {
    "id": "smart_hardware",
    "label": "智能硬件",
    "aliases": [
      "硬件",
      "智能终端",
      "智能设备"
    ],
    "choices": [
      "consumer_electronics_appliances",
      "computing_network_equipment",
      "industrial_equipment",
      "aerospace_defense"
    ]
  },
  {
    "id": "automotive_oem",
    "label": "整车厂",
    "aliases": [
      "车企",
      "主机厂",
      "整车",
      "汽车主机厂"
    ],
    "choices": [
      "vehicles",
      "industrial_equipment"
    ]
  },
  {
    "id": "supply_chain",
    "label": "汽车及电子供应链",
    "aliases": [
      "供应商",
      "汽车供应链",
      "电子供应链",
      "汽车供应商",
      "汽车及电子供应链"
    ],
    "choices": [
      "semiconductors",
      "electronic_components",
      "auto_components",
      "electrical_energy_equipment"
    ]
  },
  {
    "id": "energy_environment",
    "label": "能源／电力／环保",
    "aliases": [
      "能源",
      "电力",
      "新能源",
      "环保"
    ],
    "choices": [
      "energy_supply",
      "electrical_energy_equipment",
      "environment_water"
    ]
  },
  {
    "id": "industrial",
    "label": "工业制造／机械装备",
    "aliases": [
      "工业制造",
      "机械装备",
      "自动化",
      "机械"
    ],
    "choices": [
      "industrial_equipment",
      "electronic_components",
      "electrical_energy_equipment"
    ]
  },
  {
    "id": "healthcare",
    "label": "医药／医疗健康",
    "aliases": [
      "医药",
      "医疗",
      "制药",
      "生物医药"
    ],
    "choices": [
      "pharma_biotech",
      "medical_devices",
      "medical_services"
    ]
  },
  {
    "id": "construction",
    "label": "建筑／地产／基础设施",
    "aliases": [
      "建筑",
      "地产",
      "基建",
      "物业"
    ],
    "choices": [
      "construction_engineering",
      "real_estate_property"
    ]
  },
  {
    "id": "aerospace_transport_equipment",
    "label": "航空航天／船舶／轨道装备",
    "aliases": [
      "航空航天",
      "军工",
      "船舶",
      "轨道装备"
    ],
    "choices": [
      "aerospace_defense",
      "ship_rail_equipment"
    ]
  },
  {
    "id": "professional_services",
    "label": "咨询／科研／专业服务",
    "aliases": [
      "咨询",
      "科研",
      "研究所",
      "专业服务",
      "检测认证"
    ],
    "choices": [
      "business_services",
      "research_testing",
      "construction_engineering"
    ]
  },
  {
    "id": "logistics_trade",
    "label": "交通物流／贸易",
    "aliases": [
      "物流",
      "运输",
      "贸易",
      "航运",
      "快递"
    ],
    "choices": [
      "transport_logistics",
      "commerce_trade"
    ]
  },
  {
    "id": "consumer",
    "label": "消费品／零售／餐饮",
    "aliases": [
      "消费品",
      "快消",
      "零售",
      "餐饮",
      "酒店",
      "服装"
    ],
    "choices": [
      "consumer_goods",
      "food_beverage",
      "commerce_trade",
      "hospitality_tourism"
    ]
  },
  {
    "id": "materials_chemicals",
    "label": "石化／材料／矿冶",
    "aliases": [
      "石化",
      "化工",
      "材料",
      "矿冶",
      "钢铁",
      "造纸"
    ],
    "choices": [
      "chemicals_materials",
      "mining_basic_materials",
      "energy_supply"
    ]
  },
  {
    "id": "media_tourism",
    "label": "文化传媒／旅游",
    "aliases": [
      "文化",
      "传媒",
      "旅游",
      "影视",
      "出版",
      "广告"
    ],
    "choices": [
      "media_advertising",
      "hospitality_tourism"
    ]
  },
  {
    "id": "agriculture",
    "label": "农林牧渔",
    "aliases": [
      "农业",
      "农林牧渔",
      "农牧",
      "养殖"
    ],
    "choices": [
      "agriculture_farming",
      "chemicals_materials"
    ]
  },
  {
    "id": "telecom",
    "label": "通信／运营商",
    "aliases": [
      "通信",
      "电信",
      "运营商"
    ],
    "choices": [
      "telecom_services",
      "computing_network_equipment"
    ]
  },
  {
    "id": "diversified",
    "label": "综合集团／投资运营",
    "aliases": [
      "综合集团",
      "投资集团",
      "产业运营"
    ],
    "choices": []
  }
]);
const lookup=new Map();
for(const x of INDUSTRIES)for(const k of [x.id,x.label,...x.aliases]){
 if(lookup.has(k)&&lookup.get(k)!==x.id)throw Error('行业别名冲突：'+k);lookup.set(k,x.id);
}
// Old broad preferences require an explicit new selection; never silently narrow a saved query.
const legacy=new Map(LEGACY_INDUSTRIES.flatMap(x=>[x.id,x.label,...x.aliases].map(k=>[k,x])));
export function normalizeIndustries(value,{required=true}={}){
 const input=typeof value==='string'?value.trim():value;
 const items=(Array.isArray(input)?input:typeof input==='string'?(lookup.has(input)||legacy.has(input)?[input]:input.split(/[,，、]/)):[]).map(x=>String(x).trim()).filter(Boolean);
 if(!items.length){if(required)throw Error('请先指定行业，可多选：'+INDUSTRIES.map(x=>x.label).join('、')+'；或明确选择“不限行业”。');return [];}
 const normalized=items.map(x=>{
  if(['all','不限','不限行业','全部行业'].includes(x))return 'all';
  if(lookup.has(x))return lookup.get(x);
  if(legacy.has(x)){const old=legacy.get(x);throw Error('旧行业分类需要重新选择：'+old.label+'；候选新行业：'+(old.choices.length?old.choices.map(id=>INDUSTRIES.find(i=>i.id===id).label).join('；'):'请按实际经营板块从 industries 列表选择')+'。原有公司标签不会按旧类别自动展开。');}
  throw Error('未识别的行业：'+x+'；请使用 industries 中的选项。');
 });return normalized.includes('all')?['all']:[...new Set(normalized)];
}
export const industryMatches=(company,filters)=>filters.includes('all')||(company.industry_tags||[]).some(x=>filters.includes(x));
export const industryLabels=ids=>ids.map(id=>{const old=LEGACY_INDUSTRIES.find(x=>x.id===id);return id==='all'?'不限行业':INDUSTRIES.find(x=>x.id===id)?.label||(old?old.label+'（旧分类）':id);});
export function validateIndustryTags(value){
 if(!Array.isArray(value)||new Set(value).size!==value.length||value.some(id=>!INDUSTRIES.some(x=>x.id===id)))throw Error('Invalid published industry tags');
 return value;
}
export function routeCompanies(sources,filters){return sources.filter(s=>industryMatches(s,normalizeIndustries(filters)));}
